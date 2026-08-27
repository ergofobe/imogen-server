import { createHmac, timingSafeEqual } from 'node:crypto'
import type { AssetQuery } from '@imogen/shared'
import { and, desc, eq, inArray, isNotNull, isNull, sql } from 'drizzle-orm'
import type { Database } from '../db/index.ts'
import { albumAssets, assets, users } from '../db/schema.ts'
import { BULK_BATCH_SIZE, chunk } from '../lib/batch.ts'
import { badRequest, forbidden } from '../lib/errors.ts'
import { toAsset } from '../media/serialize.ts'

const UNLOCK_TTL_MS = 15 * 60 * 1000
const MIN_PASSPHRASE_LENGTH = 8
const MAX_ATTEMPTS = 5
const LOCKOUT_MS = 5 * 60 * 1000

/** Same cost as an account password: this guards the photos someone chose to hide. */
const ARGON2 = { algorithm: 'argon2id', memoryCost: 19456, timeCost: 2 } as const

export class VaultError extends Error {
  readonly status: number
  readonly code: string

  constructor(code: string, message: string, status = 403) {
    super(message)
    this.name = 'VaultError'
    this.code = code
    this.status = status
  }
}

/**
 * A vault holds photographs the owner wants kept out of the ordinary library — not
 * merely archived, but absent from the timeline, from search, from albums, from shared
 * links, and from anything an AI assistant can reach.
 *
 * Its passphrase is deliberately not the account password. Single sign-on users have no
 * local password at all, and more importantly a session that is already signed in should
 * not be enough: the whole point is that finding someone's laptop open does not open
 * this too.
 */
export class VaultService {
  constructor(
    private readonly db: Database,
    /** `batchSize` is overridable so a test can cross the batch boundary cheaply. */
    private readonly options: { secret: string; batchSize?: number },
  ) {}

  async isConfigured(userId: string): Promise<boolean> {
    const [row] = await this.db
      .select({ hash: users.vaultPassphraseHash })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1)
    return Boolean(row?.hash)
  }

  async setPassphrase(userId: string, passphrase: string): Promise<void> {
    if (passphrase.length < MIN_PASSPHRASE_LENGTH) {
      throw new VaultError(
        'weak_passphrase',
        `Use at least ${MIN_PASSPHRASE_LENGTH} characters`,
        400,
      )
    }
    await this.db
      .update(users)
      .set({
        vaultPassphraseHash: await Bun.password.hash(passphrase, ARGON2),
        vaultFailedAttempts: 0,
        vaultLockedUntil: null,
        updatedAt: new Date(),
      })
      .where(eq(users.id, userId))
  }

  /**
   * Returns a token proving this session may see the vault, for the next few minutes.
   * The token is bound to both the account and the session, so a cookie copied out of
   * one browser is inert in another.
   */
  async unlock(
    userId: string,
    passphrase: string,
    sessionId: string,
    ttlMs: number = UNLOCK_TTL_MS,
  ): Promise<string> {
    const [row] = await this.db
      .select({
        hash: users.vaultPassphraseHash,
        attempts: users.vaultFailedAttempts,
        lockedUntil: users.vaultLockedUntil,
      })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1)

    if (!row?.hash) throw new VaultError('not_configured', 'This vault has not been set up', 400)

    if (row.lockedUntil && row.lockedUntil.getTime() > Date.now()) {
      const seconds = Math.ceil((row.lockedUntil.getTime() - Date.now()) / 1000)
      throw new VaultError('locked_out', `Too many attempts. Try again in ${seconds}s.`, 429)
    }

    // Bun.password.verify is constant-time, so a wrong guess leaks nothing by timing.
    if (!(await Bun.password.verify(passphrase, row.hash))) {
      const attempts = row.attempts + 1
      await this.db
        .update(users)
        .set({
          vaultFailedAttempts: attempts,
          vaultLockedUntil: attempts >= MAX_ATTEMPTS ? new Date(Date.now() + LOCKOUT_MS) : null,
        })
        .where(eq(users.id, userId))
      throw new VaultError('invalid_passphrase', 'That passphrase is not correct', 403)
    }

    await this.db
      .update(users)
      .set({ vaultFailedAttempts: 0, vaultLockedUntil: null })
      .where(eq(users.id, userId))

    const expiresAt = Date.now() + ttlMs
    return `${expiresAt}.${this.sign(userId, sessionId, expiresAt)}`
  }

  verify(token: string | undefined, userId: string, sessionId: string): boolean {
    if (!token) return false
    const separator = token.indexOf('.')
    if (separator < 1) return false

    const expiresAt = Number(token.slice(0, separator))
    if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) return false

    // The expiry is inside the signature, so extending it invalidates the token.
    const presented = Buffer.from(token.slice(separator + 1))
    const expected = Buffer.from(this.sign(userId, sessionId, expiresAt))
    return presented.length === expected.length && timingSafeEqual(presented, expected)
  }

  private sign(userId: string, sessionId: string, expiresAt: number): string {
    return createHmac('sha256', this.options.secret)
      .update(`vault:${userId}:${sessionId}:${expiresAt}`)
      .digest('base64url')
  }

  /**
   * Moves assets into the vault, and out of every album on the way in — an album is a
   * shareable surface, so leaving a vaulted photo in one would defeat the exercise.
   *
   * Batched: a query-resolved selection can run to tens of thousands of ids, and the
   * update's `inArray` binds one parameter per id — Postgres refuses a statement bound
   * past 65,535. Returns every id actually moved, across every batch, so a caller (faces
   * forgetting what was vaulted) acts on what happened rather than what was requested.
   */
  async moveIn(userId: string, assetIds: string[]): Promise<string[]> {
    const movedIds: string[] = []
    for (const batch of chunk(assetIds, this.options.batchSize ?? BULK_BATCH_SIZE)) {
      const moved = await this.db
        .update(assets)
        .set({ vaultedAt: new Date(), updatedAt: new Date() })
        .where(and(eq(assets.ownerId, userId), inArray(assets.id, batch), isNull(assets.vaultedAt)))
        .returning({ id: assets.id })

      if (moved.length > 0) {
        await this.db.delete(albumAssets).where(
          inArray(
            albumAssets.assetId,
            moved.map((m) => m.id),
          ),
        )
      }
      movedIds.push(...moved.map((m) => m.id))
    }
    return movedIds
  }

  async moveOut(userId: string, assetIds: string[]): Promise<number> {
    if (assetIds.length === 0) return 0
    const moved = await this.db
      .update(assets)
      .set({ vaultedAt: null, updatedAt: new Date() })
      .where(and(eq(assets.ownerId, userId), inArray(assets.id, assetIds)))
      .returning({ id: assets.id })
    return moved.length
  }

  async list(userId: string, query: Pick<AssetQuery, 'limit' | 'sort' | 'order'>) {
    const rows = await this.db
      .select()
      .from(assets)
      .where(and(eq(assets.ownerId, userId), isNotNull(assets.vaultedAt), isNull(assets.deletedAt)))
      .orderBy(desc(assets.capturedAt), desc(assets.id))
      .limit(query.limit + 1)

    const hasMore = rows.length > query.limit
    return {
      items: rows.slice(0, query.limit).map(toAsset),
      nextCursor: null as string | null,
      total: null as number | null,
      hasMore,
    }
  }

  /** Used by the file routes: a vaulted asset's bytes need the unlock token too. */
  async isVaulted(assetId: string): Promise<boolean> {
    const [row] = await this.db
      .select({ vaultedAt: assets.vaultedAt })
      .from(assets)
      .where(eq(assets.id, assetId))
      .limit(1)
    return Boolean(row?.vaultedAt)
  }

  async count(userId: string): Promise<number> {
    const [row] = await this.db
      .select({ count: sql<number>`count(*)::int` })
      .from(assets)
      .where(and(eq(assets.ownerId, userId), isNotNull(assets.vaultedAt), isNull(assets.deletedAt)))
    return Number(row?.count ?? 0)
  }
}

export function asHttpError(error: unknown): unknown {
  if (error instanceof VaultError) {
    return error.status === 400 ? badRequest(error.message) : forbidden(error.message)
  }
  return error
}
