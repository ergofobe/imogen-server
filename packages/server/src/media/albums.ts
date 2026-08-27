import type {
  Album,
  AlbumAssetsResult,
  AlbumCreate,
  AlbumUpdate,
  Asset,
  ShareLink,
  ShareLinkCreate,
} from '@imogen/shared'
import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm'
import type { Database } from '../db/index.ts'
import { type AlbumRow, albumAssets, albums, assets, shareLinks } from '../db/schema.ts'
import { BULK_BATCH_SIZE, chunk } from '../lib/batch.ts'
import { forbidden, notFound } from '../lib/errors.ts'
import { generateToken } from '../lib/tokens.ts'
import { toAsset } from './serialize.ts'

function toAlbum(row: AlbumRow, assetCount: number, shareSlug: string | null): Album {
  return {
    id: row.id,
    ownerId: row.ownerId,
    name: row.name,
    description: row.description,
    coverAssetId: row.coverAssetId,
    assetCount,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    shareSlug,
  }
}

function toShareLink(row: typeof shareLinks.$inferSelect, publicUrl: string): ShareLink {
  return {
    slug: row.slug,
    url: `${publicUrl}/share/${row.slug}`,
    albumId: row.albumId,
    assetId: row.assetId,
    expiresAt: row.expiresAt?.toISOString() ?? null,
    allowDownload: row.allowDownload,
    createdAt: row.createdAt.toISOString(),
  }
}

const SHARE_PASSWORD_HASH = { algorithm: 'argon2id', memoryCost: 19456, timeCost: 2 } as const

function hashSharePassword(password: string): Promise<string> {
  return Bun.password.hash(password, SHARE_PASSWORD_HASH)
}

/**
 * The photograph that stands for an album.
 *
 * Derived rather than stored. Nothing was ever setting `cover_asset_id`, so albums
 * were made and stayed faceless — and keeping it up to date would mean touching it
 * whenever a photo is added, removed, trashed or vaulted, with every one of those a
 * chance for the cover to point at something that should not be seen.
 *
 * An explicitly chosen cover still wins. Trashed and vaulted photographs are excluded:
 * the vault exists so its contents appear nowhere else, and an album tile is
 * emphatically somewhere else.
 */
const coverAssetId = sql<string | null>`coalesce(
  ${albums.coverAssetId},
  (
    select ${albumAssets.assetId}
    from ${albumAssets}
    join ${assets} on ${assets.id} = ${albumAssets.assetId}
    where ${albumAssets.albumId} = ${albums.id}
      and ${assets.deletedAt} is null
      and ${assets.vaultedAt} is null
    order by ${albumAssets.position}, ${albumAssets.addedAt}
    limit 1
  )
)`

export class AlbumService {
  /** Overridable so a test can cross the batch boundary without seeding thousands of rows. */
  constructor(
    private readonly db: Database,
    private readonly batchSize: number = BULK_BATCH_SIZE,
  ) {}

  async list(ownerId: string): Promise<Album[]> {
    const rows = await this.db
      .select({
        album: albums,
        assetCount: sql<number>`count(${albumAssets.assetId})::int`,
        shareSlug: sql<string | null>`max(${shareLinks.slug})`,
        cover: coverAssetId,
      })
      .from(albums)
      .leftJoin(albumAssets, eq(albumAssets.albumId, albums.id))
      .leftJoin(shareLinks, and(eq(shareLinks.albumId, albums.id), isNull(shareLinks.revokedAt)))
      .where(eq(albums.ownerId, ownerId))
      .groupBy(albums.id)
      .orderBy(desc(albums.updatedAt))
    return rows.map((r) =>
      toAlbum({ ...r.album, coverAssetId: r.cover }, Number(r.assetCount), r.shareSlug),
    )
  }

  async get(ownerId: string, albumId: string): Promise<Album> {
    const [row] = await this.db
      .select({ album: albums, cover: coverAssetId })
      .from(albums)
      .where(eq(albums.id, albumId))
      .limit(1)
      .then((rows) => rows.map((r) => ({ ...r.album, coverAssetId: r.cover })))
    if (!row) throw notFound('No such album')
    if (row.ownerId !== ownerId) throw forbidden('That album belongs to someone else')

    const [counted] = await this.db
      .select({ count: sql<number>`count(*)::int` })
      .from(albumAssets)
      .where(eq(albumAssets.albumId, albumId))
    const [share] = await this.db
      .select({ slug: shareLinks.slug })
      .from(shareLinks)
      .where(and(eq(shareLinks.albumId, albumId), isNull(shareLinks.revokedAt)))
      .limit(1)

    return toAlbum(row, Number(counted?.count ?? 0), share?.slug ?? null)
  }

  async getWithAssets(ownerId: string, albumId: string) {
    const album = await this.get(ownerId, albumId)
    const rows = await this.db
      .select({ asset: assets })
      .from(albumAssets)
      .innerJoin(assets, eq(assets.id, albumAssets.assetId))
      .where(
        and(eq(albumAssets.albumId, albumId), isNull(assets.deletedAt), isNull(assets.vaultedAt)),
      )
      /*
       * Newest first, the same as the timeline.
       *
       * This used to lead with `position`, which is assigned as things are inserted
       * and so held the order they happened to be added in — and since the query that
       * gathers them has no ORDER BY of its own, that order came from whatever the
       * database felt like returning. The result read as scrambled, or as the reverse
       * of the timeline, depending on the day.
       *
       * The id breaks ties so two photographs taken in the same second do not swap
       * places between requests.
       */
      .orderBy(desc(assets.capturedAt), desc(assets.id))
    return { ...album, assets: rows.map((r) => toAsset(r.asset)) }
  }

  async create(ownerId: string, input: AlbumCreate): Promise<Album> {
    const [row] = await this.db
      .insert(albums)
      .values({ ownerId, name: input.name, description: input.description ?? null })
      .returning()
    const album = row!
    if (input.assetIds?.length) {
      await this.addAssets(ownerId, album.id, input.assetIds)
    }
    return this.get(ownerId, album.id)
  }

  async update(ownerId: string, albumId: string, patch: AlbumUpdate): Promise<Album> {
    await this.get(ownerId, albumId)
    await this.db
      .update(albums)
      .set({
        ...(patch.name !== undefined ? { name: patch.name } : {}),
        ...(patch.description !== undefined ? { description: patch.description } : {}),
        ...(patch.coverAssetId !== undefined ? { coverAssetId: patch.coverAssetId } : {}),
        updatedAt: new Date(),
      })
      .where(eq(albums.id, albumId))
    return this.get(ownerId, albumId)
  }

  async remove(ownerId: string, albumId: string): Promise<void> {
    await this.get(ownerId, albumId)
    // Deleting an album never deletes photos; they stay in the timeline.
    await this.db.delete(albums).where(eq(albums.id, albumId))
  }

  /**
   * Batched: a query-resolved selection can run to tens of thousands of ids, and both
   * the owned-assets lookup and the membership insert bind one parameter per id (the
   * insert binds three — album id, asset id, position — so it is the tighter limit).
   * Postgres refuses a statement bound past 65,535 parameters; `this.batchSize` stays
   * comfortably under that for every shape here.
   */
  async addAssets(
    ownerId: string,
    albumId: string,
    assetIds: string[],
  ): Promise<AlbumAssetsResult> {
    await this.get(ownerId, albumId)

    const [maxPosition] = await this.db
      .select({ max: sql<number>`coalesce(max(${albumAssets.position}), -1)::int` })
      .from(albumAssets)
      .where(eq(albumAssets.albumId, albumId))
    let position = Number(maxPosition?.max ?? -1)

    let added = 0
    for (const batch of chunk(assetIds, this.batchSize)) {
      // Only the caller's own assets, so an album cannot be used to reach someone else's.
      const owned = await this.db
        .select({ id: assets.id })
        .from(assets)
        .where(
          and(eq(assets.ownerId, ownerId), inArray(assets.id, batch), isNull(assets.vaultedAt)),
        )
        // Nothing displays `position` today, but a column that decides an order should
        // not be filled from whatever order the rows came back in.
        .orderBy(desc(assets.capturedAt), desc(assets.id))
      const ownedIds = owned.map((a) => a.id)
      if (ownedIds.length === 0) continue

      const inserted = await this.db
        .insert(albumAssets)
        .values(ownedIds.map((assetId) => ({ albumId, assetId, position: ++position })))
        .onConflictDoNothing()
        .returning({ assetId: albumAssets.assetId })
      added += inserted.length
    }

    await this.db.update(albums).set({ updatedAt: new Date() }).where(eq(albums.id, albumId))

    const [counted] = await this.db
      .select({ count: sql<number>`count(*)::int` })
      .from(albumAssets)
      .where(eq(albumAssets.albumId, albumId))

    return {
      added,
      skipped: assetIds.length - added,
      assetCount: Number(counted?.count ?? 0),
    }
  }

  /** Batched for the same reason `addAssets` is: a selection's ids can outrun the bind limit. */
  async removeAssets(ownerId: string, albumId: string, assetIds: string[]): Promise<number> {
    await this.get(ownerId, albumId)
    let removed = 0
    for (const batch of chunk(assetIds, this.batchSize)) {
      const rows = await this.db
        .delete(albumAssets)
        .where(and(eq(albumAssets.albumId, albumId), inArray(albumAssets.assetId, batch)))
        .returning({ assetId: albumAssets.assetId })
      removed += rows.length
    }
    await this.db.update(albums).set({ updatedAt: new Date() }).where(eq(albums.id, albumId))
    return removed
  }

  // --- Sharing ---

  async createShareLink(
    ownerId: string,
    albumId: string,
    input: ShareLinkCreate,
    publicUrl: string,
  ): Promise<ShareLink> {
    await this.get(ownerId, albumId)
    // Revoke any previous link so one album has at most one live URL.
    await this.db
      .update(shareLinks)
      .set({ revokedAt: new Date() })
      .where(and(eq(shareLinks.albumId, albumId), isNull(shareLinks.revokedAt)))

    const slug = generateToken('s', 12).replace('s_', '')
    const [row] = await this.db
      .insert(shareLinks)
      .values({
        slug,
        albumId,
        createdBy: ownerId,
        // A share password is chosen by a human, so it needs a salted, slow KDF —
        // unlike the high-entropy random tokens elsewhere, which SHA-256 handles fine.
        passwordHash: input.password ? await hashSharePassword(input.password) : null,
        allowDownload: input.allowDownload,
        expiresAt: input.expiresAt ? new Date(input.expiresAt) : null,
      })
      .returning()

    return toShareLink(row!, publicUrl)
  }

  /**
   * Shares one photograph.
   *
   * Same rules as an album: at most one live link per photo, so revoking is a single
   * act rather than a hunt through everything ever made.
   */
  async createAssetShareLink(
    ownerId: string,
    assetId: string,
    input: ShareLinkCreate,
    publicUrl: string,
  ): Promise<ShareLink> {
    const [owned] = await this.db
      .select({ id: assets.id })
      .from(assets)
      .where(and(eq(assets.id, assetId), eq(assets.ownerId, ownerId), isNull(assets.deletedAt)))
      .limit(1)
    if (!owned) throw notFound('No such photo')

    await this.db
      .update(shareLinks)
      .set({ revokedAt: new Date() })
      .where(and(eq(shareLinks.assetId, assetId), isNull(shareLinks.revokedAt)))

    const slug = generateToken('s', 12).replace('s_', '')
    const [row] = await this.db
      .insert(shareLinks)
      .values({
        slug,
        assetId,
        createdBy: ownerId,
        passwordHash: input.password ? await hashSharePassword(input.password) : null,
        allowDownload: input.allowDownload,
        expiresAt: input.expiresAt ? new Date(input.expiresAt) : null,
      })
      .returning()

    return toShareLink(row!, publicUrl)
  }

  async revokeAssetShareLink(ownerId: string, assetId: string): Promise<void> {
    await this.db
      .update(shareLinks)
      .set({ revokedAt: new Date() })
      .where(
        and(
          eq(shareLinks.assetId, assetId),
          eq(shareLinks.createdBy, ownerId),
          isNull(shareLinks.revokedAt),
        ),
      )
  }

  /** The live link for one album, if it has one. */
  async albumShareLink(
    ownerId: string,
    albumId: string,
    publicUrl: string,
  ): Promise<ShareLink | null> {
    await this.get(ownerId, albumId)
    const [row] = await this.db
      .select()
      .from(shareLinks)
      .where(and(eq(shareLinks.albumId, albumId), isNull(shareLinks.revokedAt)))
      .limit(1)
    return row ? toShareLink(row, publicUrl) : null
  }

  /** The live link for one photograph, if it has one. */
  async assetShareLink(
    ownerId: string,
    assetId: string,
    publicUrl: string,
  ): Promise<ShareLink | null> {
    const [row] = await this.db
      .select()
      .from(shareLinks)
      .where(
        and(
          eq(shareLinks.assetId, assetId),
          eq(shareLinks.createdBy, ownerId),
          isNull(shareLinks.revokedAt),
        ),
      )
      .limit(1)
    return row ? toShareLink(row, publicUrl) : null
  }

  async revokeShareLink(ownerId: string, albumId: string): Promise<void> {
    await this.get(ownerId, albumId)
    await this.db
      .update(shareLinks)
      .set({ revokedAt: new Date() })
      .where(and(eq(shareLinks.albumId, albumId), isNull(shareLinks.revokedAt)))
  }

  /**
   * Resolves a public share slug, reporting whether it is password-protected without
   * requiring the password. The caller decides whether the visitor has proved they know
   * it; this keeps the credential out of the query string.
   */
  /**
   * Resolves a public link, whether it points at an album or a single photograph.
   *
   * A photograph is presented as an album holding exactly it. That keeps one shape
   * for the whole public surface — the membership check that stops a slug becoming a
   * key to the entire library, the asset route, the page itself — rather than a
   * second path through all of it that would need the same guards written twice.
   */
  async openShare(slug: string): Promise<OpenedShare | null> {
    const link = await this.findLiveLink(slug)
    if (!link) return null
    if (link.assetId) return this.openPhotoShare(link)
    if (!link.albumId) return null

    const [album] = await this.db.select().from(albums).where(eq(albums.id, link.albumId)).limit(1)
    if (!album) return null

    const rows = await this.db
      .select({ asset: assets })
      .from(albumAssets)
      .innerJoin(assets, eq(assets.id, albumAssets.assetId))
      .where(
        and(
          eq(albumAssets.albumId, link.albumId),
          isNull(assets.deletedAt),
          isNull(assets.vaultedAt),
        ),
      )
      .orderBy(desc(assets.capturedAt), desc(assets.id))

    return {
      link,
      requiresPassword: link.passwordHash !== null,
      album: {
        ...toAlbum(album, rows.length, link.slug),
        assets: rows.map((r) => toAsset(r.asset)),
      },
    }
  }

  /** A single shared photograph, dressed as an album of one. */
  private async openPhotoShare(link: typeof shareLinks.$inferSelect): Promise<OpenedShare | null> {
    const [row] = await this.db
      .select()
      .from(assets)
      .where(and(eq(assets.id, link.assetId!), isNull(assets.deletedAt), isNull(assets.vaultedAt)))
      .limit(1)
    if (!row) return null

    const asset = toAsset(row)
    return {
      link,
      requiresPassword: link.passwordHash !== null,
      album: {
        // The link's own id, so nothing here can be mistaken for a real album.
        id: link.id,
        ownerId: link.createdBy,
        name: asset.originalFilename,
        description: null,
        coverAssetId: asset.id,
        assetCount: 1,
        createdAt: link.createdAt.toISOString(),
        updatedAt: link.createdAt.toISOString(),
        shareSlug: link.slug,
        assets: [asset],
      },
    }
  }

  async checkSharePassword(slug: string, password: string): Promise<boolean> {
    const link = await this.findLiveLink(slug)
    if (!link) return false
    if (!link.passwordHash) return true
    // Bun.password.verify is constant-time, so a wrong guess leaks nothing by timing.
    return Bun.password.verify(password, link.passwordHash)
  }

  private async findLiveLink(slug: string) {
    const [link] = await this.db
      .select()
      .from(shareLinks)
      .where(and(eq(shareLinks.slug, slug), isNull(shareLinks.revokedAt)))
      .limit(1)
    if (!link) return null
    if (link.expiresAt && link.expiresAt.getTime() <= Date.now()) return null
    return link
  }
}

export type OpenedShare = {
  link: typeof shareLinks.$inferSelect
  requiresPassword: boolean
  album: Album & { assets: Asset[] }
}
