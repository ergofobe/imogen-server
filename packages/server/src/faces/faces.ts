import { and, cosineDistance, desc, eq, inArray, isNotNull, isNull, sql } from 'drizzle-orm'
import type ort from 'onnxruntime-node'
import type { Database } from '../db/index.ts'
import { assets, faces, people, settings } from '../db/schema.ts'
import { FACE_BACKFILL_JOB, FACE_MODELS_JOB } from '../jobs/faces.ts'
import { forbidden, notFound } from '../lib/errors.ts'
import { bestMatch, CLUSTER, updateCentroid } from './cluster.ts'
import { detect } from './detect.ts'
import type { ModelStore } from './models.ts'
import { embedFace } from './recognize.ts'

const ENABLED_KEY = 'faces.enabled'
/** How many people the index is asked for before choosing among them. */
const MATCH_CANDIDATES = 12

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

    const { detection, recognition } = await this.ready()
    const path = this.originalPath(asset.originalPath)

    const { faces: found } = await detect(detection, path, CLUSTER.minDetectionScore)
    const usable = found.filter(
      (f) =>
        f.box[2] - f.box[0] >= CLUSTER.minFaceSize && f.box[3] - f.box[1] >= CLUSTER.minFaceSize,
    )

    // Recorded before the early return: a landscape with no faces in it has still been
    // looked at, and must not come back round on the next backfill.
    await this.db.update(assets).set({ facesScannedAt: new Date() }).where(eq(assets.id, assetId))

    if (usable.length === 0) return 0

    // Re-processing a photo replaces its faces rather than duplicating them.
    await this.db.delete(faces).where(eq(faces.assetId, assetId))

    for (const face of usable) {
      const embedding = await embedFace(recognition, path, face)
      await this.recordFace(asset.ownerId, assetId, face, embedding)
    }

    await this.refreshCounts(asset.ownerId)
    return usable.length
  }

  /**
   * Files one face: finds or creates its person and stores the face, together.
   *
   * Both halves happen in one transaction under a per-owner advisory lock, and that
   * matters twice over. Without the lock, workers scanning several photos of one person
   * at once each find nobody yet and each create a separate person — three photographs
   * of one face became three different people the first time this met the job queue.
   * And unless the two halves are atomic, the housekeeping pass can delete a person who
   * has no faces yet, in the instant between creating them and storing the face, leaving
   * the face attached to nobody.
   *
   * Only this step is serialised. Detection and embedding, where the time actually goes,
   * stay parallel.
   */
  private async recordFace(
    ownerId: string,
    assetId: string,
    face: { box: [number, number, number, number]; score: number },
    embedding: Float32Array,
  ): Promise<string> {
    const vector = Array.from(embedding)

    return this.db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`faces:${ownerId}`}))`)

      // The index narrows the field; the threshold decision is made in one place.
      const nearby = await tx
        .select({ id: people.id, centroid: people.centroid, faceCount: people.faceCount })
        .from(people)
        .where(and(eq(people.ownerId, ownerId), isNotNull(people.centroid)))
        .orderBy(cosineDistance(people.centroid, vector))
        .limit(MATCH_CANDIDATES)

      const match = bestMatch(
        embedding,
        nearby.map((p) => ({ id: p.id, centroid: new Float32Array(p.centroid as number[]) })),
      )

      let personId: string
      if (match) {
        const existing = nearby.find((p) => p.id === match.id)!
        const centroid = updateCentroid(match.centroid, existing.faceCount, embedding)
        await tx
          .update(people)
          .set({
            centroid: Array.from(centroid),
            faceCount: existing.faceCount + 1,
            updatedAt: new Date(),
          })
          .where(eq(people.id, match.id))
        personId = match.id
      } else {
        const [created] = await tx
          .insert(people)
          .values({ ownerId, centroid: vector, faceCount: 1 })
          .returning({ id: people.id })
        personId = created!.id
      }

      await tx.insert(faces).values({
        assetId,
        ownerId,
        personId,
        x: Math.round(face.box[0]),
        y: Math.round(face.box[1]),
        width: Math.round(face.box[2] - face.box[0]),
        height: Math.round(face.box[3] - face.box[1]),
        score: face.score,
        embedding: vector,
      })
      return personId
    })
  }

  /**
   * Recomputes how many faces each person has, counting only photos that are actually
   * visible — a person's count must never include a vaulted or trashed photo.
   */
  async refreshCounts(ownerId: string): Promise<void> {
    await this.db.execute(sql`
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
        group by f.person_id
      ) as counted
      where ${people.id} = counted.person_id and ${people.ownerId} = ${ownerId}
    `)

    // A person whose every photo went to the vault or the trash is no longer a person.
    await this.db.execute(sql`
      delete from ${people}
      where ${people.ownerId} = ${ownerId}
        and not exists (
          select 1 from ${faces} f
          join ${assets} a on a.id = f.asset_id
          where f.person_id = ${people.id}
            and a.vaulted_at is null
            and a.deleted_at is null
        )
    `)
  }

  /** Recounts after photos come or go without their faces changing — trash, restore. */
  async refreshFor(ownerId: string): Promise<void> {
    if (!(await this.isEnabled())) return
    await this.refreshCounts(ownerId)
  }

  /** Called when a photo is vaulted: its faces stop existing. */
  async forgetAsset(assetId: string, ownerId: string): Promise<void> {
    await this.db.delete(faces).where(eq(faces.assetId, assetId))
    await this.refreshCounts(ownerId)
  }

  /** The same as forgetting one, for a selection that may run to tens of thousands. */
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
   */
  async mergePeople(ownerId: string, keepId: string, mergeIds: string[]): Promise<number> {
    const keep = await this.getPerson(ownerId, keepId)
    const others = mergeIds.filter((id) => id !== keepId)
    if (others.length === 0) return 0

    for (const id of others) await this.getPerson(ownerId, id)

    const moved = await this.db
      .update(faces)
      .set({ personId: keepId, confirmed: true })
      .where(and(eq(faces.ownerId, ownerId), inArray(faces.personId, others)))
      .returning({ id: faces.id })

    await this.db.delete(people).where(inArray(people.id, others))
    await this.recomputeCentroid(keepId)
    await this.refreshCounts(ownerId)
    void keep
    return moved.length
  }

  /** Moves specific faces to a different person — the fix when clustering guessed wrong. */
  async reassignFaces(ownerId: string, faceIds: string[], personId: string | null) {
    if (personId) await this.getPerson(ownerId, personId)
    await this.db
      .update(faces)
      .set({ personId, confirmed: true })
      .where(and(eq(faces.ownerId, ownerId), inArray(faces.id, faceIds)))

    if (personId) await this.recomputeCentroid(personId)
    await this.refreshCounts(ownerId)
  }

  private async recomputeCentroid(personId: string): Promise<void> {
    const rows = await this.db
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

    await this.db
      .update(people)
      .set({
        centroid: Array.from(mean, (v) => v / norm),
        faceCount: rows.length,
        updatedAt: new Date(),
      })
      .where(eq(people.id, personId))
  }

  /** The photos a person appears in. Vaulted and trashed photos are never among them. */
  async photosOf(ownerId: string, personId: string, limit = 500) {
    await this.getPerson(ownerId, personId)
    const rows = await this.db
      .selectDistinctOn([assets.id], { asset: assets })
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
