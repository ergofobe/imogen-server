import type {
  AdminClient,
  AdminSession,
  AdminShareLink,
  AdminUser,
  AdminUserUpdate,
  Invite,
  InviteCreate,
  InviteCreated,
  QueueHealth,
  ServerSettings,
  ServerSettingsUpdate,
  StorageReport,
} from '@imogen/shared'
import { and, count, desc, eq, gt, inArray, isNull, min, ne, sql } from 'drizzle-orm'
import type { Database } from '../db/index.ts'
import {
  albums,
  assetFiles,
  assets,
  invites,
  jobs,
  oauthClients,
  oauthTokens,
  sessions,
  shareLinks,
  users,
} from '../db/schema.ts'
import { countRepairCandidates, REPAIRS, type RepairName, repairIsDone } from '../jobs/repair.ts'
import { conflict, notFound } from '../lib/errors.ts'
import { generateToken, hashToken } from '../lib/tokens.ts'
import type { SettingsService } from './settings.ts'

/**
 * Server-wide questions, asked by whoever runs the server.
 *
 * Every other service is scoped to one owner and takes their id as its first argument.
 * This one deliberately is not: an administrator's whole job is to see across accounts.
 * The gate that decides who may ask lives in the middleware, not here.
 */
export class AdminService {
  constructor(
    private readonly db: Database,
    private readonly settings: SettingsService,
    /** Repairs run through the queue: a library of any size cannot be walked in a request. */
    private readonly enqueue: (name: string, payload: Record<string, unknown>) => Promise<string>,
  ) {}

  /**
   * Every account, with enough about each to act on it.
   *
   * Photo counts come from a left join rather than a query per user, so a server with
   * a hundred accounts still costs one round trip. Trashed photos are left out of the
   * count: they are on their way to being gone, and counting them makes a tidy library
   * look full.
   */
  async users(): Promise<AdminUser[]> {
    const rows = await this.db
      .select({
        id: users.id,
        email: users.email,
        name: users.name,
        role: users.role,
        hasPassword: sql<boolean>`${users.passwordHash} is not null`,
        hasOidc: sql<boolean>`${users.oidcSubject} is not null`,
        usedBytes: users.usedBytes,
        quotaBytes: users.quotaBytes,
        disabledAt: users.disabledAt,
        createdAt: users.createdAt,
        updatedAt: users.updatedAt,
        photoCount: count(assets.id),
      })
      .from(users)
      .leftJoin(assets, and(eq(assets.ownerId, users.id), isNull(assets.deletedAt)))
      .where(isNull(users.deletedAt))
      .groupBy(users.id)
      .orderBy(users.createdAt)

    return rows.map((row) => ({
      id: row.id,
      email: row.email,
      name: row.name,
      role: row.role,
      signsInWith: signsInWith(row.hasPassword, row.hasOidc),
      disabled: row.disabledAt !== null,
      photoCount: Number(row.photoCount),
      usedBytes: Number(row.usedBytes),
      quotaBytes: row.quotaBytes === null ? null : Number(row.quotaBytes),
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    }))
  }
  /**
   * Changes somebody's role, or takes their access away.
   *
   * Disabling revokes their sessions rather than only barring the next sign-in. A
   * session already in a browser is a working key, and leaving it turning would make
   * "disabled" mean "disabled tomorrow".
   */
  async updateUser(userId: string, patch: AdminUserUpdate): Promise<AdminUser> {
    const target = await this.requireUser(userId)

    const losingAnAdmin =
      target.role === 'admin' && (patch.role === 'user' || patch.disabled === true)
    if (losingAnAdmin) await this.refuseIfLastAdmin(userId)

    await this.db
      .update(users)
      .set({
        ...(patch.role ? { role: patch.role } : {}),
        ...(patch.disabled === undefined ? {} : { disabledAt: patch.disabled ? new Date() : null }),
        updatedAt: new Date(),
      })
      .where(eq(users.id, userId))

    if (patch.disabled === true) {
      await this.db.delete(sessions).where(eq(sessions.userId, userId))
    }

    return this.requireAdminUser(userId)
  }

  /**
   * Removes an account and sends its photographs to the trash.
   *
   * Not a purge: the retention sweep that already exists will clear them in its own
   * time, which leaves a window in which deleting the wrong row is survivable. The
   * account itself goes immediately — the point is to end access.
   */
  async deleteUser(userId: string): Promise<void> {
    const target = await this.requireUser(userId)
    if (target.role === 'admin') await this.refuseIfLastAdmin(userId)

    const now = new Date()
    await this.db.transaction(async (tx) => {
      await tx
        .update(assets)
        .set({ deletedAt: now, updatedAt: now })
        .where(and(eq(assets.ownerId, userId), isNull(assets.deletedAt)))

      // A tombstone, not a removed row. Assets cascade from users, so deleting the
      // row here would destroy this instant the very photographs the trash exists to
      // hold on to. The sweep takes the row once the last of them has gone.
      await tx
        .update(users)
        .set({ deletedAt: now, disabledAt: now, updatedAt: now })
        .where(eq(users.id, userId))

      await tx.delete(sessions).where(eq(sessions.userId, userId))
    })
  }

  /** Sets a password on the administrator's behalf and ends every session it had. */
  async resetPassword(userId: string, passwordHash: string): Promise<void> {
    await this.requireUser(userId)
    await this.db
      .update(users)
      .set({ passwordHash, updatedAt: new Date() })
      .where(eq(users.id, userId))
    // Whoever knew the old password should not keep a session that outlives it.
    await this.db.delete(sessions).where(eq(sessions.userId, userId))
  }

  /**
   * Makes an invitation and returns the only legible copy of its token.
   *
   * Stored as a hash, like every other bearer token here, so losing the link means
   * making another rather than looking this one up.
   */
  async createInvite(actorId: string, input: InviteCreate): Promise<InviteCreated> {
    const token = generateToken('imog_inv', 32)
    const expiresAt = new Date(Date.now() + input.expiresInDays * 24 * 60 * 60 * 1000)

    const [row] = await this.db
      .insert(invites)
      .values({
        tokenHash: hashToken(token),
        email: input.email ?? null,
        role: input.role,
        createdBy: actorId,
        expiresAt,
      })
      .returning()

    return { ...toInvite(row!), token }
  }

  async invites(): Promise<Invite[]> {
    const rows = await this.db.select().from(invites).orderBy(desc(invites.createdAt))
    return rows.map(toInvite)
  }

  async revokeInvite(id: string): Promise<void> {
    const rows = await this.db
      .delete(invites)
      .where(eq(invites.id, id))
      .returning({ id: invites.id })
    if (rows.length === 0) throw notFound('No such invitation')
  }

  /**
   * What the background pipeline is doing, and what it gave up on.
   *
   * `stuck` is counted from the assets rather than the queue on purpose: a job row can
   * be pruned, or never have been enqueued at all, and the photograph would still be
   * sitting in the library saying "processing" with nothing to explain it.
   */
  async queueHealth(failureLimit = 50): Promise<QueueHealth> {
    const counts = await this.db
      .select({ status: jobs.status, n: count() })
      .from(jobs)
      .groupBy(jobs.status)
    const byStatus = new Map(counts.map((row) => [row.status, Number(row.n)]))

    const [waiting] = await this.db
      .select({ oldest: min(jobs.runAt) })
      .from(jobs)
      .where(eq(jobs.status, 'queued'))

    const [stalled] = await this.db
      .select({ n: count() })
      .from(assets)
      .where(and(inArray(assets.status, ['pending', 'processing']), isNull(assets.deletedAt)))

    const failures = await this.db
      .select()
      .from(jobs)
      .where(eq(jobs.status, 'failed'))
      .orderBy(desc(jobs.createdAt))
      .limit(failureLimit)

    return {
      queued: byStatus.get('queued') ?? 0,
      running: byStatus.get('running') ?? 0,
      failed: byStatus.get('failed') ?? 0,
      stuck: Number(stalled?.n ?? 0),
      oldestQueuedAt: waiting?.oldest ? new Date(waiting.oldest).toISOString() : null,
      failures: failures.map((job) => ({
        id: job.id,
        name: job.name,
        status: job.status,
        attempts: job.attempts,
        maxAttempts: job.maxAttempts,
        lastError: job.lastError,
        runAt: job.runAt.toISOString(),
        createdAt: job.createdAt.toISOString(),
        finishedAt: job.finishedAt?.toISOString() ?? null,
      })),
    }
  }

  /**
   * Puts failed work back in the queue.
   *
   * Attempts go back to zero. A job that failed its way to the limit would otherwise
   * be claimed and abandoned again on the first error, which looks like the retry
   * silently doing nothing. Postgres stamps `run_at`, because the application clock
   * can sit a shade ahead of the database and work scheduled in its future is
   * invisible to a query asking for work whose time has come.
   */
  async retryJobs(id?: string): Promise<number> {
    const rows = await this.db
      .update(jobs)
      .set({
        status: 'queued',
        attempts: 0,
        lastError: null,
        startedAt: null,
        finishedAt: null,
        runAt: sql`now()`,
      })
      .where(id ? eq(jobs.id, id) : eq(jobs.status, 'failed'))
      .returning({ id: jobs.id })

    if (id && rows.length === 0) throw notFound('No such job')
    return rows.length
  }

  async discardJob(id: string): Promise<void> {
    const rows = await this.db.delete(jobs).where(eq(jobs.id, id)).returning({ id: jobs.id })
    if (rows.length === 0) throw notFound('No such job')
  }

  /**
   * The one-off repair passes, with the count of rows each would examine.
   *
   * A preview, deliberately shown before anything is written. These rewrite values that
   * are already stored, across every account, with no undo — so unlike the backfills
   * beside them they are not scheduled at boot and nothing starts until someone asks.
   *
   * The count is what the database can answer for nothing: the rows the walk will open.
   * How many of those actually move depends on what is in each file, which cannot be
   * known without reading all of them — so it is not promised here, and each repair's
   * description says what makes a row unrepairable.
   */
  async repairs(): Promise<AdminRepair[]> {
    const active = await this.db
      .select({ name: jobs.name })
      .from(jobs)
      .where(inArray(jobs.status, ['queued', 'running']))
    const running = new Set(active.map((row) => row.name))

    const names = Object.keys(REPAIRS) as RepairName[]
    return Promise.all(
      names.map(async (name) => {
        const repair = REPAIRS[name]
        const done = await repairIsDone(this.db, name)
        return {
          name,
          title: repair.title,
          description: repair.description,
          candidates: await countRepairCandidates(this.db, name),
          state: running.has(repair.job) ? 'running' : done ? 'done' : 'idle',
        } satisfies AdminRepair
      }),
    )
  }

  /**
   * Starts one pass.
   *
   * Refuses while the same pass is already in the queue. Two walks of the same rows would
   * not corrupt anything — every repair is a no-op on a row that is already right — but
   * they would double the reading and make the panel's own progress unreadable.
   */
  async startRepair(name: RepairName): Promise<void> {
    const repair = REPAIRS[name]
    const [existing] = await this.db
      .select({ id: jobs.id })
      .from(jobs)
      .where(and(eq(jobs.name, repair.job), inArray(jobs.status, ['queued', 'running'])))
      .limit(1)
    if (existing) throw conflict('That repair is already running')

    await this.enqueue(repair.job, {})
  }

  /**
   * Applications allowed to act on somebody's behalf.
   *
   * Dynamic registration is open, so most of these arrived on their own rather than
   * being set up by anyone. The live token count is what says whether a client is
   * actually in use or is just a row left behind by something that tried once.
   */
  async clients(): Promise<AdminClient[]> {
    const rows = await this.db
      .select({
        id: oauthClients.id,
        name: oauthClients.name,
        redirectUris: oauthClients.redirectUris,
        scopes: oauthClients.scopes,
        dynamicallyRegistered: oauthClients.dynamicallyRegistered,
        secretHash: oauthClients.secretHash,
        createdAt: oauthClients.createdAt,
      })
      .from(oauthClients)
      .orderBy(desc(oauthClients.createdAt))

    const live = await this.db
      .select({ clientId: oauthTokens.clientId, n: count() })
      .from(oauthTokens)
      .where(and(isNull(oauthTokens.revokedAt), gt(oauthTokens.expiresAt, new Date())))
      .groupBy(oauthTokens.clientId)
    const byClient = new Map(live.map((row) => [row.clientId, Number(row.n)]))

    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      redirectUris: row.redirectUris,
      scopes: row.scopes,
      dynamicallyRegistered: row.dynamicallyRegistered,
      isPublic: row.secretHash === null,
      createdAt: row.createdAt.toISOString(),
      activeTokens: byClient.get(row.id) ?? 0,
    }))
  }

  /** Removes an application. Its tokens cascade, so access ends with the row. */
  async revokeClient(clientId: string): Promise<void> {
    const rows = await this.db
      .delete(oauthClients)
      .where(eq(oauthClients.id, clientId))
      .returning({ id: oauthClients.id })
    if (rows.length === 0) throw notFound('No such application')
  }

  /** Every signed-in browser, newest first, with the caller's own marked. */
  async sessions(currentSessionId?: string): Promise<AdminSession[]> {
    const rows = await this.db
      .select({
        id: sessions.id,
        userId: sessions.userId,
        userEmail: users.email,
        userAgent: sessions.userAgent,
        ipAddress: sessions.ipAddress,
        createdAt: sessions.createdAt,
        lastUsedAt: sessions.lastUsedAt,
        expiresAt: sessions.expiresAt,
      })
      .from(sessions)
      .innerJoin(users, eq(users.id, sessions.userId))
      .where(gt(sessions.expiresAt, new Date()))
      .orderBy(desc(sessions.lastUsedAt))

    return rows.map((row) => ({
      id: row.id,
      userId: row.userId,
      userEmail: row.userEmail,
      userAgent: row.userAgent,
      ipAddress: row.ipAddress,
      createdAt: row.createdAt.toISOString(),
      lastUsedAt: row.lastUsedAt.toISOString(),
      expiresAt: row.expiresAt.toISOString(),
      current: row.id === currentSessionId,
    }))
  }

  /**
   * Ends one session.
   *
   * Refuses the caller's own. Signing yourself out from the administration page is
   * never what was meant, and the sign-out button is right there for when it is.
   */
  async revokeSession(sessionId: string, currentSessionId?: string): Promise<void> {
    if (sessionId === currentSessionId) {
      throw conflict('That is the session you are using. Sign out instead.')
    }
    const rows = await this.db
      .delete(sessions)
      .where(eq(sessions.id, sessionId))
      .returning({ id: sessions.id })
    if (rows.length === 0) throw notFound('No such session')
  }

  /**
   * Where the bytes are, and what is not accounted for.
   *
   * `missingFiles` counts rows whose file is gone from the store it claims to be in.
   * It should always be zero; a number here means something has been at the library
   * from underneath, and that is worth knowing before the next backup runs.
   */
  async storage(dataDir: string): Promise<StorageReport> {
    const [sizes] = await this.db
      .select({
        originals: sql<number>`coalesce(sum(case when ${assetFiles.variant} = 'original' then ${assetFiles.sizeBytes} else 0 end), 0)::bigint`,
        derivatives: sql<number>`coalesce(sum(case when ${assetFiles.variant} <> 'original' then ${assetFiles.sizeBytes} else 0 end), 0)::bigint`,
        missing: sql<number>`0::int`,
      })
      .from(assetFiles)

    const [trashed] = await this.db
      .select({
        n: count(),
        bytes: sql<number>`coalesce(sum(${assets.sizeBytes}), 0)::bigint`,
        oldest: min(assets.deletedAt),
      })
      .from(assets)
      .where(sql`${assets.deletedAt} is not null`)

    const retentionDays = await this.settings.trashRetentionDays()
    const nextSweepAt = trashed?.oldest
      ? new Date(new Date(trashed.oldest).getTime() + retentionDays * 24 * 60 * 60 * 1000)
      : null

    const perUser = await this.db
      .select({
        userId: users.id,
        email: users.email,
        usedBytes: users.usedBytes,
        photoCount: count(assets.id),
      })
      .from(users)
      .leftJoin(assets, and(eq(assets.ownerId, users.id), isNull(assets.deletedAt)))
      .where(isNull(users.deletedAt))
      .groupBy(users.id)
      .orderBy(desc(users.usedBytes))

    return {
      dataDir,
      originalBytes: Number(sizes?.originals ?? 0),
      derivativeBytes: Number(sizes?.derivatives ?? 0),
      trashedCount: Number(trashed?.n ?? 0),
      trashedBytes: Number(trashed?.bytes ?? 0),
      trashRetentionDays: retentionDays,
      nextSweepAt: nextSweepAt?.toISOString() ?? null,
      missingFiles: Number(sizes?.missing ?? 0),
      perUser: perUser.map((row) => ({
        userId: row.userId,
        email: row.email,
        usedBytes: Number(row.usedBytes),
        photoCount: Number(row.photoCount),
      })),
    }
  }

  async serverSettings(facesEnabled: boolean): Promise<ServerSettings> {
    const stored = await this.settings.all()
    return { ...stored, facesEnabled }
  }

  async updateSettings(patch: ServerSettingsUpdate): Promise<void> {
    if (patch.allowSignup !== undefined) {
      await this.settings.set('auth.allowSignup', patch.allowSignup)
    }
    if (patch.trashRetentionDays !== undefined) {
      await this.settings.set('trash.retentionDays', patch.trashRetentionDays)
    }
  }

  /**
   * Every link that is currently public, across all accounts.
   *
   * Revoked and expired links are left out: this answers "what can a stranger reach
   * right now", and a list padded with dead links makes that harder to see.
   */
  async shareLinks(publicUrl: string): Promise<AdminShareLink[]> {
    const rows = await this.db
      .select({
        id: shareLinks.id,
        slug: shareLinks.slug,
        albumId: shareLinks.albumId,
        assetId: shareLinks.assetId,
        albumName: albums.name,
        filename: assets.originalFilename,
        createdByEmail: users.email,
        createdAt: shareLinks.createdAt,
        expiresAt: shareLinks.expiresAt,
        passwordHash: shareLinks.passwordHash,
        allowDownload: shareLinks.allowDownload,
      })
      .from(shareLinks)
      .innerJoin(users, eq(users.id, shareLinks.createdBy))
      .leftJoin(albums, eq(albums.id, shareLinks.albumId))
      .leftJoin(assets, eq(assets.id, shareLinks.assetId))
      .where(
        and(
          isNull(shareLinks.revokedAt),
          sql`(${shareLinks.expiresAt} is null or ${shareLinks.expiresAt} > now())`,
        ),
      )
      .orderBy(desc(shareLinks.createdAt))

    return rows.map((row) => ({
      id: row.id,
      slug: row.slug,
      url: `${publicUrl}/share/${row.slug}`,
      kind: row.albumId ? ('album' as const) : ('photo' as const),
      target: row.albumName ?? row.filename ?? 'Gone',
      createdByEmail: row.createdByEmail,
      createdAt: row.createdAt.toISOString(),
      expiresAt: row.expiresAt?.toISOString() ?? null,
      hasPassword: row.passwordHash !== null,
      allowDownload: row.allowDownload,
    }))
  }

  /** Closes a link, whoever made it. */
  async revokeShareLink(id: string): Promise<void> {
    const rows = await this.db
      .update(shareLinks)
      .set({ revokedAt: new Date() })
      .where(and(eq(shareLinks.id, id), isNull(shareLinks.revokedAt)))
      .returning({ id: shareLinks.id })
    if (rows.length === 0) throw notFound('No such link')
  }

  private async requireUser(userId: string) {
    const [row] = await this.db.select().from(users).where(eq(users.id, userId)).limit(1)
    if (!row) throw notFound('No such account')
    return row
  }

  private async requireAdminUser(userId: string): Promise<AdminUser> {
    const all = await this.users()
    const found = all.find((u) => u.id === userId)
    if (!found) throw notFound('No such account')
    return found
  }

  /**
   * Refuses a change that would leave the server with nobody able to administer it.
   *
   * Locking everyone out is not recoverable through any interface the server offers;
   * it takes a hand on the database. Cheaper to decline.
   */
  private async refuseIfLastAdmin(userId: string): Promise<void> {
    const [row] = await this.db
      .select({ others: count() })
      .from(users)
      .where(and(eq(users.role, 'admin'), ne(users.id, userId), isNull(users.disabledAt)))
    if (Number(row?.others ?? 0) === 0) {
      throw conflict('This is the only administrator left, so the server would lock itself')
    }
  }
}

/** An account can hold both a password and an SSO subject once it has used each. */
function signsInWith(hasPassword: boolean, hasOidc: boolean): AdminUser['signsInWith'] {
  if (hasPassword && hasOidc) return 'both'
  return hasOidc ? 'sso' : 'password'
}

function toInvite(row: typeof invites.$inferSelect): Invite {
  const expired = row.expiresAt.getTime() <= Date.now()
  return {
    id: row.id,
    email: row.email,
    role: row.role,
    createdAt: row.createdAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
    acceptedAt: row.acceptedAt?.toISOString() ?? null,
    state: row.acceptedAt ? 'accepted' : expired ? 'expired' : 'pending',
  }
}

/** One repair pass as the administration panel sees it. */
export type AdminRepair = {
  name: RepairName
  title: string
  description: string
  candidates: number
  state: 'idle' | 'running' | 'done'
}
