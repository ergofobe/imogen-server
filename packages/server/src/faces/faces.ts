import { and, cosineDistance, desc, eq, inArray, isNotNull, isNull, sql } from 'drizzle-orm'
import type ort from 'onnxruntime-node'
import type { Database } from '../db/index.ts'
import { assets, faces, people, settings } from '../db/schema.ts'
import { FACE_BACKFILL_JOB, FACE_MODELS_JOB } from '../jobs/faces.ts'
import { COVER_SAMPLE } from '../lib/batch.ts'
import { forbidden, notFound } from '../lib/errors.ts'
import { bestMatch, CLUSTER, replaceInCentroid, updateCentroid } from './cluster.ts'
import { detect, type Face } from './detect.ts'
import type { ModelStore } from './models.ts'
import { matchBoxes, storedBox } from './overlap.ts'
import { embedFace } from './recognize.ts'

const ENABLED_KEY = 'faces.enabled'
/** Drizzle does not export its transaction handle; derived so it cannot drift from `Database`. */
type Tx = Parameters<Parameters<Database['transaction']>[0]>[0]

type ConfirmedFace = {
  id: string
  personId: string | null
  x: number
  y: number
  width: number
  height: number
  embedding: unknown
}
/** How many people the index is asked for before choosing among them. */
const MATCH_CANDIDATES = 12

/** One face on its way into the library, ready to be filed under whichever person wins. */
type Filing = {
  ownerId: string
  assetId: string
  face: Face
  embedding: Float32Array
  vector: number[]
  adoptable: Map<string, ConfirmedFace[]>
}

export type DetectedFace = {
  id: string
  assetId: string
  personId: string | null
  personName: string | null
  x: number
  y: number
  width: number
  height: number
  score: number
}

/**
 * Finding faces and grouping them into people.
 *
 * Deliberately off until an administrator turns it on. Biometric data carries real legal
 * weight in some jurisdictions, and scanning somebody's entire library by surprise is not
 * a reasonable default even on hardware they own — enabling it is also what triggers the
 * model download.
 */
export class FaceService {
  private sessions: {
    detection: ort.InferenceSession
    recognition: ort.InferenceSession
  } | null = null

  constructor(
    private readonly db: Database,
    private readonly models: ModelStore,
    private readonly originalPath: (relativePath: string) => string,
    private readonly enqueue: (
      name: string,
      payload: Record<string, unknown>,
      options?: { maxAttempts?: number },
    ) => Promise<unknown>,
  ) {}

  async isEnabled(): Promise<boolean> {
    const [row] = await this.db
      .select()
      .from(settings)
      .where(eq(settings.key, ENABLED_KEY))
      .limit(1)
    return (row?.value as { enabled?: boolean } | undefined)?.enabled === true
  }

  /**
   * Switching this on is what pays for the models, so scheduling the download belongs
   * here rather than in one of the routes that can flip it. The admin settings toggle
   * and the button on the people page are two such routes, and a server whose flag said
   * enabled while no download had ever been queued was the result of them disagreeing.
   */
  async setEnabled(enabled: boolean): Promise<void> {
    await this.db
      .insert(settings)
      .values({ key: ENABLED_KEY, value: { enabled } })
      .onConflictDoUpdate({
        target: settings.key,
        set: { value: { enabled }, updatedAt: new Date() },
      })

    if (!enabled) {
      this.sessions = null
      return
    }

    // 190 MB over a home connection deserves more than the default handful of attempts:
    // giving up leaves the server permanently unable to scan anything.
    if (await this.models.isReady()) await this.enqueue(FACE_BACKFILL_JOB, {})
    else await this.enqueue(FACE_MODELS_JOB, {}, { maxAttempts: 10 })
  }

  /** Whether the weights are on disk. Nothing can be scanned until they are. */
  async modelsReady(): Promise<boolean> {
    return this.models.isReady()
  }

  /** Loaded once and kept: creating a session costs far more than running one. */
  private async ready() {
    if (!this.sessions) this.sessions = await this.models.open()
    return this.sessions
  }

  /**
   * Detects, embeds, and groups every face in one photo.
   *
   * Vaulted photos are skipped outright. A face from a vaulted photo could otherwise
   * join a named person and surface that person's thumbnail — or their photo count —
   * somewhere the vault is supposed to have removed it from entirely.
   */
  async processAsset(assetId: string): Promise<number> {
    if (!(await this.isEnabled())) return 0

    const [asset] = await this.db.select().from(assets).where(eq(assets.id, assetId)).limit(1)
    if (!asset || asset.vaultedAt || asset.deletedAt || asset.type !== 'image') return 0

    // An ingest that has not finished has no file to look at yet — three uploads
    // interrupted by a crash sat at `pending` with an empty original_path, and the
    // detector burned every attempt on them. Deliberately returning before
    // facesScannedAt is stamped: unlike a landscape, this one must be scanned once
    // its upload completes.
    if (asset.status !== 'ready') return 0

    const { detection, recognition } = await this.ready()
    const path = this.originalPath(asset.originalPath)

    const confirmed = await this.confirmedFaces(assetId)
    const usable = await this.detectUsable(detection, path)

    // A landscape with no faces in it has still been looked at, and must not come back
    // round on the next backfill.
    await this.db.update(assets).set({ facesScannedAt: new Date() }).where(eq(assets.id, assetId))

    // A confirmed face is a human's decision about who is in the photo; matching it back
    // to a detection by geometry, rather than by re-clustering its embedding, lets the
    // machine refresh where the face is and what it looks like without ever touching who
    // it says it is.
    const { pairs, unmatched, orphaned } = matchBoxes(confirmed, usable)

    // Re-processing a photo replaces its unconfirmed faces rather than duplicating them —
    // including when the replacement is nothing at all. This used to clear every face on
    // the photo and sat below an early return on `usable.length === 0`, so a scan that
    // found nobody kept the previous scan's faces for ever: an edited photo, a tuned
    // threshold or a new detector all land here.
    const touched = await this.clearFaces(assetId)

    // Matched faces are refreshed before anything new is filed: filing compares against
    // each person's centroid, and a centroid still built from the embedding that has just
    // been replaced would describe someone the library no longer holds.
    for (const { confirmed: row, detection: face } of pairs) {
      const embedding = await embedFace(recognition, path, face)
      await this.lockedForPeople(asset.ownerId, row.personId ? [row.personId] : [], (tx) =>
        this.refreshFace(tx, row, face, embedding),
      )
      if (row.personId) touched.add(row.personId)
    }

    // A confirmed face nothing was detected near is not deleted: the detector missing a
    // face it once found — a tuned threshold, a different model, a re-decoded original —
    // is far more common than a person genuinely leaving a photograph, and a human can
    // unassign it. But it is offered up. When a new detection clusters onto that face's
    // person, it is the same face found somewhere else, and the human's row takes the new
    // geometry rather than gaining an unconfirmed twin pointing at the wrong pixels.
    const adoptable = new Map<string, ConfirmedFace[]>()
    for (const row of orphaned) {
      if (row.personId) adoptable.set(row.personId, [...(adoptable.get(row.personId) ?? []), row])
    }

    for (const face of unmatched) {
      const embedding = await embedFace(recognition, path, face)
      touched.add(await this.recordFace(asset.ownerId, assetId, face, embedding, adoptable))
    }

    await this.refreshCounts(asset.ownerId, [...touched])
    return usable.length
  }

  /** Confirmed faces on a photo: what a re-scan must preserve rather than re-file. */
  private async confirmedFaces(assetId: string): Promise<ConfirmedFace[]> {
    return this.db
      .select({
        id: faces.id,
        personId: faces.personId,
        x: faces.x,
        y: faces.y,
        width: faces.width,
        height: faces.height,
        embedding: faces.embedding,
      })
      .from(faces)
      .where(and(eq(faces.assetId, assetId), eq(faces.confirmed, true)))
  }

  /**
   * Refreshes a confirmed face's geometry, score, and embedding without moving who it is.
   *
   * The person's centroid moves in the same locked transaction: the running mean
   * `recordFace` maintains still contains the embedding this just replaced, and a scan on
   * another worker filing a face of the same person in between would otherwise have its
   * update overwritten.
   */
  private async refreshFace(
    tx: Tx,
    row: ConfirmedFace,
    face: Face,
    embedding: Float32Array,
  ): Promise<void> {
    await tx
      .update(faces)
      .set({ ...storedBox(face.box), score: face.score, embedding: Array.from(embedding) })
      .where(eq(faces.id, row.id))
    if (!row.personId) return

    const [person] = await tx
      .select({ centroid: people.centroid, faceCount: people.faceCount })
      .from(people)
      .where(eq(people.id, row.personId))
      .limit(1)
    if (!person) return

    const centroid = replaceInCentroid(
      person.centroid ? new Float32Array(person.centroid as number[]) : null,
      person.faceCount,
      new Float32Array(row.embedding as number[]),
      embedding,
    )
    await tx
      .update(people)
      .set({ centroid: Array.from(centroid), updatedAt: new Date() })
      .where(eq(people.id, row.personId))
  }

  /**
   * Housekeeping that can reach any of the owner's people, serialised against every
   * filing. Exclusive, and it has to be: a full recount deletes whichever people are
   * left empty, so it cannot name them in advance and has to exclude the lot.
   *
   * This used to be the only lock here, taken once per face, which made one owner's
   * whole library contend on a single key — with `lock_timeout` set, waiters are
   * cancelled rather than queued, so an import spent itself on
   * `canceling statement due to lock timeout`.
   */
  private lockedForOwner<T>(ownerId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`faces:${ownerId}`}))`)
      return fn(tx)
    })
  }

  /**
   * Work whose people are already known: exclusive on each of them, shared on the owner.
   *
   * The shared half is what keeps `lockedForOwner` meaningful — a full recount still
   * excludes every filing in flight — while costing nothing between filings, since
   * shared holders do not conflict with each other. Two faces of two different people
   * therefore never wait on one another.
   *
   * Keys are taken in a fixed order so two overlapping sets cannot form a cycle.
   */
  private lockedForPeople<T>(
    ownerId: string,
    personIds: string[],
    fn: (tx: Tx) => Promise<T>,
  ): Promise<T> {
    const keys = [...new Set(personIds)].sort()
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock_shared(hashtext(${`faces:${ownerId}`}))`)
      for (const id of keys) {
        await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`faces:person:${id}`}))`)
      }
      return fn(tx)
    })
  }

  /**
   * Removes a photo's unconfirmed faces and names the people who were in them.
   *
   * Confirmed faces are a human's decision and are spared, whether or not this scan's
   * detections matched them — only `processAsset`'s own matching step decides what
   * happens to them. One statement rather than a select and then a delete: whoever loses
   * their last face here has to be recounted afterwards or they linger in the People list
   * with a count they no longer have, and once the rows are gone nothing names them.
   * `returning` makes "which people did this affect" a property of the delete itself, so
   * the two cannot drift apart.
   */
  private async clearFaces(assetId: string): Promise<Set<string>> {
    const removed = await this.db
      .delete(faces)
      .where(and(eq(faces.assetId, assetId), eq(faces.confirmed, false)))
      .returning({ personId: faces.personId })

    return new Set(removed.map((row) => row.personId).filter((id): id is string => id !== null))
  }

  /** The faces in an image that are big enough to be worth embedding. */
  private async detectUsable(detection: ort.InferenceSession, path: string) {
    const { faces: found } = await detect(detection, path, CLUSTER.minDetectionScore)
    return found.filter(
      (f) =>
        f.box[2] - f.box[0] >= CLUSTER.minFaceSize && f.box[3] - f.box[1] >= CLUSTER.minFaceSize,
    )
  }

  /**
   * Asks one photograph whether it still contains the faces on record for it, and removes
   * them if it does not. Reports whether anything was repaired.
   *
   * This is the repair for libraries that lost faces before `processAsset` learned to
   * clear them, and it deliberately stops at detection rather than re-scanning. It exists
   * only to answer "does this photograph still have anyone in it", so embedding is wasted
   * work on one that does — and re-filing its unconfirmed faces would re-cluster them,
   * shuffling groupings that a repair has no business changing.
   *
   * So a photograph that still has faces is not written to at all, and one that has lost
   * them keeps no embedding work either: detection alone settles it.
   */
  async recheckAsset(assetId: string): Promise<boolean> {
    if (!(await this.isEnabled())) return false

    const [asset] = await this.db.select().from(assets).where(eq(assets.id, assetId)).limit(1)
    if (!asset || asset.vaultedAt || asset.deletedAt || asset.type !== 'image') return false
    if (asset.status !== 'ready') return false

    const { detection } = await this.ready()
    const usable = await this.detectUsable(detection, this.originalPath(asset.originalPath))
    if (usable.length > 0) return false

    const touched = await this.clearFaces(assetId)
    if (touched.size === 0) return false

    await this.refreshCounts(asset.ownerId, [...touched])
    return true
  }

  /**
   * Files one face: finds or creates its person and stores the face, together.
   *
   * Choosing the person and writing the face have to be atomic, or the housekeeping pass
   * can delete a person in the instant between the two and leave the face attached to
   * nobody. And two workers must not both decide a face belongs to nobody yet and each
   * create a person for it — three photographs of one face became three different people
   * the first time this met the job queue.
   *
   * Only the second of those needs a lock over the owner, and only when it actually
   * creates someone: a person that does not exist yet cannot be named in a lock key.
   * So the candidate search runs first, unlocked, purely to learn which lock to take —
   * the authoritative decision is always made again under it. A face that joins somebody
   * already known therefore contends with that person alone.
   *
   * Creating someone stays owner-wide, and there is nothing narrower to take: the whole
   * question is whether the person exists, so no key names them, and sharding the key on
   * the embedding would let two shards create the same person — the failure the lock is
   * here to prevent. So this path is not fixed, only made rarer. Its cost is bounded by
   * how many people a library has rather than how many faces, since every face after the
   * first of each person joins instead, and the hold is what it always was: one candidate
   * query and the writes, with the unlocked probe outside it. A library being scanned for
   * the very first time, where most faces really are somebody new, still serialises.
   *
   * Detection and embedding, where the time actually goes, are outside all of this.
   */
  private async recordFace(
    ownerId: string,
    assetId: string,
    face: Face,
    embedding: Float32Array,
    adoptable: Map<string, ConfirmedFace[]> = new Map(),
  ): Promise<string> {
    const filing = { ownerId, assetId, face, embedding, vector: Array.from(embedding), adoptable }

    const candidate = await this.bestPerson(this.db, ownerId, embedding, filing.vector)
    if (candidate) {
      const joined = await this.lockedForPeople(ownerId, [candidate], (tx) =>
        this.joinPerson(tx, candidate, filing),
      )
      if (joined) return joined
    }

    return this.lockedForOwner(ownerId, async (tx) => {
      // Re-asked under the exclusive lock, so a person another worker created while the
      // probe above was running is found rather than duplicated.
      const under = await this.bestPerson(tx, ownerId, embedding, filing.vector)
      const joined = under && (await this.joinPerson(tx, under, filing))
      if (joined) return joined

      const [created] = await tx
        .insert(people)
        .values({ ownerId, centroid: filing.vector, faceCount: 1 })
        .returning({ id: people.id })
      await this.insertFace(tx, filing, created!.id)
      return created!.id
    })
  }

  /** The person this face belongs to, if any. The index narrows; the threshold decides. */
  private async bestPerson(
    exec: Database | Tx,
    ownerId: string,
    embedding: Float32Array,
    vector: number[],
  ): Promise<string | null> {
    const nearby = await exec
      .select({ id: people.id, centroid: people.centroid })
      .from(people)
      .where(and(eq(people.ownerId, ownerId), isNotNull(people.centroid)))
      .orderBy(cosineDistance(people.centroid, vector))
      .limit(MATCH_CANDIDATES)

    const match = bestMatch(
      embedding,
      nearby.map((p) => ({ id: p.id, centroid: new Float32Array(p.centroid as number[]) })),
    )
    return match?.id ?? null
  }

  /**
   * Adds a face to a person already known, returning them — or null if they are not
   * there to be joined, which sends the caller round to the create path.
   *
   * The centroid is re-read and the threshold re-applied, because the candidate search
   * ran unlocked and the mean can have moved since — and not only by the one face a
   * concurrent filing adds. `mergePeople` and `reassignFaces` both recompute it over a
   * different set of faces entirely, so a small cluster matched at 0.52 can become a
   * three-hundred-face person by the time the lock is granted. Filing into that on the
   * strength of the old reading is exactly the merge of two people that
   * `CLUSTER.matchThreshold` is set high to avoid. Below the threshold this returns null
   * and the caller starts again, which is the cheap mistake of the two.
   */
  private async joinPerson(tx: Tx, personId: string, filing: Filing): Promise<string | null> {
    const [person] = await tx
      .select({ centroid: people.centroid, faceCount: people.faceCount })
      .from(people)
      .where(eq(people.id, personId))
      .limit(1)
    if (!person?.centroid) return null

    const centroid = new Float32Array(person.centroid as number[])
    if (!bestMatch(filing.embedding, [{ id: personId, centroid }])) return null

    // Clustering agrees with the human: this is their face, found somewhere new. Each
    // orphaned row is taken once, so a second detection of the same person moves the
    // next one rather than the same one twice.
    const orphan = filing.adoptable.get(personId)?.shift()
    if (orphan) {
      await this.refreshFace(tx, orphan, filing.face, filing.embedding)
      return personId
    }

    const moved = updateCentroid(centroid, person.faceCount, filing.embedding)
    await tx
      .update(people)
      .set({
        centroid: Array.from(moved),
        faceCount: person.faceCount + 1,
        updatedAt: new Date(),
      })
      .where(eq(people.id, personId))
    await this.insertFace(tx, filing, personId)
    return personId
  }

  private insertFace(tx: Tx, filing: Filing, personId: string): Promise<unknown> {
    return tx.insert(faces).values({
      assetId: filing.assetId,
      ownerId: filing.ownerId,
      personId,
      ...storedBox(filing.face.box),
      score: filing.face.score,
      embedding: filing.vector,
    })
  }

  /**
   * Recomputes how many faces each person has, counting only photos that are actually
   * visible — a person's count must never include a vaulted or trashed photo.
   *
   * Under the same locks a filing takes, and for the same reason. This rewrites `people`
   * rows and then deletes the empty ones, so it is housekeeping of exactly the kind those
   * locks exist to keep away from a filing in progress. Unlocked, four job workers
   * recounting one owner's 5,758 people put three backends in a lock cycle on this UPDATE
   * — `deadlock detected` on repeat, `faces_person_id_people_id_fk` violations where the
   * DELETE landed between a person being chosen and their face being written, and finally
   * the 10s `lock_timeout` taking the server down with it.
   *
   * Which lock follows from the scope. `personIds` narrows both statements to those
   * people, so it needs only their keys and two scans of different photographs recount in
   * parallel; omitted, every one of the owner's is recounted and any of them may be
   * deleted, so nothing can be named in advance and the owner's key is taken exclusively.
   * That unscoped form is what trash, restore, merge and reassign want. Scanning one
   * photograph does not: it can only change the people in that photograph, so recounting
   * the rest rewrites thousands of rows to the values they already held. Against the
   * production owner above that was 5,758 rows per photograph across 28,320 photographs,
   * every rewrite leaving a dead tuple on a table carrying an HNSW index.
   *
   * Narrowing is safe because both quantities are local: `face_count` and `cover_face_id`
   * are functions of one person's own faces, and only a person with a face on the changed
   * asset can have either of them move.
   */
  async refreshCounts(ownerId: string, personIds?: string[]): Promise<void> {
    // Naming nobody means nobody — distinct from naming no one *in particular*, which is
    // what an absent scope means. A scan that touched no person owes no recount at all.
    if (personIds?.length === 0) return

    const facesInScope = personIds ? sql`and ${inArray(sql`f.person_id`, personIds)}` : sql``
    const peopleInScope = personIds ? sql`and ${inArray(people.id, personIds)}` : sql``

    const recount = async (tx: Tx) => {
      await tx.execute(sql`
        update ${people} set face_count = counted.total, cover_face_id = counted.cover
        from (
          select f.person_id,
                 count(*)::int as total,
                 (array_agg(f.id order by f.score desc))[1] as cover
          from ${faces} f
          join ${assets} a on a.id = f.asset_id
          where f.owner_id = ${ownerId}
            and a.vaulted_at is null
            and a.deleted_at is null
            ${facesInScope}
          group by f.person_id
        ) as counted
        where ${people.id} = counted.person_id and ${people.ownerId} = ${ownerId}
      `)

      // A person whose every photo went to the vault or the trash is no longer a person.
      await tx.execute(sql`
        delete from ${people}
        where ${people.ownerId} = ${ownerId}
          ${peopleInScope}
          and not exists (
            select 1 from ${faces} f
            join ${assets} a on a.id = f.asset_id
            where f.person_id = ${people.id}
              and a.vaulted_at is null
              and a.deleted_at is null
          )
      `)
    }

    if (personIds) await this.lockedForPeople(ownerId, personIds, recount)
    else await this.lockedForOwner(ownerId, recount)
  }

  /** Recounts after photos come or go without their faces changing — trash, restore. */
  async refreshFor(ownerId: string): Promise<void> {
    if (!(await this.isEnabled())) return
    await this.refreshCounts(ownerId)
  }

  /** Called when a photo is vaulted: its faces stop existing. Also used for a set of many. */
  async forgetAssets(assetIds: string[], ownerId: string): Promise<void> {
    if (assetIds.length === 0) return
    await this.db
      .delete(faces)
      .where(and(eq(faces.ownerId, ownerId), inArray(faces.assetId, assetIds)))
    await this.refreshCounts(ownerId)
  }

  async listPeople(ownerId: string, includeHidden = false) {
    const rows = await this.db
      .select({
        id: people.id,
        name: people.name,
        coverFaceId: people.coverFaceId,
        faceCount: people.faceCount,
        hidden: people.hidden,
      })
      .from(people)
      .where(
        includeHidden
          ? eq(people.ownerId, ownerId)
          : and(eq(people.ownerId, ownerId), eq(people.hidden, false)),
      )
      .orderBy(desc(people.faceCount))
    return rows.filter((p) => p.faceCount > 0)
  }

  async getPerson(ownerId: string, personId: string) {
    const [row] = await this.db.select().from(people).where(eq(people.id, personId)).limit(1)
    if (!row) throw notFound('No such person')
    if (row.ownerId !== ownerId) throw forbidden('That person belongs to someone else')
    return row
  }

  async renamePerson(ownerId: string, personId: string, name: string | null) {
    await this.getPerson(ownerId, personId)
    await this.db.update(people).set({ name, updatedAt: new Date() }).where(eq(people.id, personId))
  }

  async setHidden(ownerId: string, personId: string, hidden: boolean) {
    await this.getPerson(ownerId, personId)
    await this.db
      .update(people)
      .set({ hidden, updatedAt: new Date() })
      .where(eq(people.id, personId))
  }

  /**
   * Folds one person into another. The surviving person keeps its name if it has one,
   * and every moved face is marked confirmed so re-clustering never undoes a human's
   * decision.
   *
   * The move, the delete and the new centroid are one locked transaction over everybody
   * involved. The delete used to stand on its own, outside any lock, which left a scan
   * free to file a face onto one of the people being merged away — between the move and
   * the delete, so the face is not moved and the person it points at is gone. That is the
   * `faces_person_id_people_id_fk` violation the housekeeping comments describe, arrived
   * at from the other direction.
   *
   * The survivor is confirmed again inside that transaction. `getPerson` answers for the
   * caller — whose person this is, and a 404 rather than a constraint — but it answers
   * before the lock is granted, and an unscoped recount deleting a `keep` whose photos
   * have all just been trashed is exactly what that window lets through. A merged-away
   * person needs no such check: the move simply matches nothing.
   */
  async mergePeople(ownerId: string, keepId: string, mergeIds: string[]): Promise<number> {
    const keep = await this.getPerson(ownerId, keepId)
    const others = mergeIds.filter((id) => id !== keepId)
    if (others.length === 0) return 0

    for (const id of others) await this.getPerson(ownerId, id)

    const moved = await this.lockedForPeople(ownerId, [keepId, ...others], async (tx) => {
      if (!(await this.stillThere(tx, keepId))) throw notFound('No such person')

      const rows = await tx
        .update(faces)
        .set({ personId: keepId, confirmed: true })
        .where(and(eq(faces.ownerId, ownerId), inArray(faces.personId, others)))
        .returning({ id: faces.id })

      await tx.delete(people).where(inArray(people.id, others))
      await this.recomputeCentroid(keepId, tx)
      return rows.length
    })

    await this.refreshCounts(ownerId)
    void keep
    return moved
  }

  /**
   * Moves specific faces to a different person — the fix when clustering guessed wrong.
   *
   * Naming a person puts the move under their lock alongside the new centroid, for the
   * reason `mergePeople` gives: between the check that they exist and the write that
   * points a face at them, a recount is free to find them empty and delete them.
   * Unassigning names nobody, and writing a null cannot point at a person who has gone.
   * `getPerson` above answers for the caller and cannot bind, since it runs before the
   * lock is granted; the re-read inside does the binding.
   */
  async reassignFaces(ownerId: string, faceIds: string[], personId: string | null) {
    const move = (tx: Tx | Database) =>
      tx
        .update(faces)
        .set({ personId, confirmed: true })
        .where(and(eq(faces.ownerId, ownerId), inArray(faces.id, faceIds)))

    if (personId) {
      await this.getPerson(ownerId, personId)
      await this.lockedForPeople(ownerId, [personId], async (tx) => {
        if (!(await this.stillThere(tx, personId))) throw notFound('No such person')
        await move(tx)
        await this.recomputeCentroid(personId, tx)
      })
    } else {
      await move(this.db)
    }

    await this.refreshCounts(ownerId)
  }

  /** Whether the person is still there, asked under the lock, where the answer holds. */
  private async stillThere(tx: Tx, personId: string): Promise<boolean> {
    const [row] = await tx
      .select({ id: people.id })
      .from(people)
      .where(eq(people.id, personId))
      .limit(1)
    return row !== undefined
  }

  private async recomputeCentroid(personId: string, tx: Tx): Promise<void> {
    const rows = await tx
      .select({ embedding: faces.embedding })
      .from(faces)
      .where(eq(faces.personId, personId))
    if (rows.length === 0) return

    const dimensions = 512
    const mean = new Float32Array(dimensions)
    for (const row of rows) {
      const v = row.embedding as number[]
      for (let i = 0; i < dimensions; i++) mean[i]! += v[i]!
    }
    let norm = 0
    for (let i = 0; i < dimensions; i++) {
      mean[i]! /= rows.length
      norm += mean[i]! * mean[i]!
    }
    norm = Math.sqrt(norm) || 1

    await tx
      .update(people)
      .set({
        centroid: Array.from(mean, (v) => v / norm),
        faceCount: rows.length,
        updatedAt: new Date(),
      })
      .where(eq(people.id, personId))
  }

  /**
   * A sample of the photographs a person appears in, newest first. This used to be
   * `selectDistinctOn([assets.id])` with no `orderBy` at all, which meant an arbitrary
   * `limit` in whatever order Postgres felt like handing back uuids — not the most
   * recent, and grouped by day it read as noise. The grid now comes from the timeline
   * under a `personId` filter; this is the cover sample.
   *
   * Postgres requires the `distinct on` expressions to lead the `order by`, so the
   * dedup key is `(capturedAt, id)` rather than `id` alone — the pair is exactly as
   * unique as `id` alone (it's still one row per asset), and is the order wanted
   * anyway. A person can have more than one face in the same photograph, and the join
   * would otherwise hand back that photograph once per face.
   */
  async photosOf(ownerId: string, personId: string, limit = COVER_SAMPLE) {
    await this.getPerson(ownerId, personId)
    const rows = await this.db
      .selectDistinctOn([assets.capturedAt, assets.id], { asset: assets })
      .from(faces)
      .innerJoin(assets, eq(assets.id, faces.assetId))
      .where(
        and(
          eq(faces.personId, personId),
          eq(faces.ownerId, ownerId),
          isNull(assets.vaultedAt),
          isNull(assets.deletedAt),
        ),
      )
      .orderBy(desc(assets.capturedAt), desc(assets.id))
      .limit(limit)
    return rows.map((r) => r.asset)
  }

  /**
   * The faces in one photo, with whoever they belong to.
   *
   * Hidden people are still reported here: someone looking at a photograph should be
   * told who is in it, even if they have chosen not to see that person in the People
   * list. Hiding is about the index, not about concealing a photo's own contents.
   */
  async facesForAsset(ownerId: string, assetId: string): Promise<DetectedFace[]> {
    const rows = await this.db
      .select({ face: faces, personName: people.name })
      .from(faces)
      .leftJoin(people, eq(people.id, faces.personId))
      .where(and(eq(faces.assetId, assetId), eq(faces.ownerId, ownerId)))
      .orderBy(desc(faces.score))

    return rows.map(({ face: f, personName }) => ({
      id: f.id,
      assetId: f.assetId,
      personId: f.personId,
      personName: personName ?? null,
      x: f.x,
      y: f.y,
      width: f.width,
      height: f.height,
      score: f.score,
    }))
  }

  /** Finds people by name, for search and for the assistant tool. */
  async findPeopleByName(ownerId: string, query: string) {
    return this.db
      .select({ id: people.id, name: people.name, faceCount: people.faceCount })
      .from(people)
      .where(
        and(
          eq(people.ownerId, ownerId),
          eq(people.hidden, false),
          isNotNull(people.name),
          sql`${people.name} ilike ${`%${query}%`}`,
        ),
      )
      .orderBy(desc(people.faceCount))
      .limit(10)
  }
}
