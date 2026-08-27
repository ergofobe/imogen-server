import { createHmac, timingSafeEqual } from 'node:crypto'
import { TimelineBucketQuery, TimelineQuery } from '@imogen/shared'
import { and, eq, isNull } from 'drizzle-orm'
import { Hono } from 'hono'
import { getCookie, setCookie } from 'hono/cookie'
import type { AppEnv } from '../auth/middleware.ts'
import { albumAssets, assetFiles, assets } from '../db/schema.ts'
import { badRequest, notFound, unauthorized } from '../lib/errors.ts'
import type { OpenedShare } from '../media/albums.ts'
import type { Services } from '../services.ts'

const UNLOCK_TTL_MS = 12 * 60 * 60 * 1000

const cookieName = (slug: string) => `imogen_share_${slug}`

/**
 * A password-protected share is unlocked once, by POST, and the proof is kept in an
 * HttpOnly cookie. The password never travels in a URL: URLs end up in access logs,
 * browser history, and Referer headers. A cookie is also the only credential an
 * `<img src>` can carry, since it cannot set a header.
 */
function signUnlock(secret: string, slug: string, expiresAt: number): string {
  const signature = createHmac('sha256', secret).update(`${slug}.${expiresAt}`).digest('base64url')
  return `${expiresAt}.${signature}`
}

function verifyUnlock(secret: string, slug: string, token: string | undefined): boolean {
  if (!token) return false
  const separator = token.indexOf('.')
  if (separator < 1) return false

  const expiresAt = Number(token.slice(0, separator))
  if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) return false

  const presented = Buffer.from(token)
  const expected = Buffer.from(signUnlock(secret, slug, expiresAt))
  return presented.length === expected.length && timingSafeEqual(presented, expected)
}

/**
 * Public album shares. These endpoints are deliberately unauthenticated — the slug is
 * the credential — so every one of them resolves the share first and serves only what
 * that share contains.
 */
export function createShareRoutes() {
  const app = new Hono<AppEnv>()

  // A shared page must not leak its slug to whatever the visitor clicks through to.
  app.use('*', async (c, next) => {
    await next()
    c.header('Referrer-Policy', 'no-referrer')
  })

  app.post('/:slug/unlock', async (c) => {
    const services = c.get('services')
    const slug = c.req.param('slug')
    const body = (await c.req.json().catch(() => ({}))) as { password?: unknown }
    if (typeof body.password !== 'string') throw badRequest('A password is required')

    const share = await services.albums.openShare(slug)
    if (!share) throw notFound('This link is not valid, or it has expired')
    if (!(await services.albums.checkSharePassword(slug, body.password))) {
      throw unauthorized('That password is not correct')
    }

    const expiresAt = Date.now() + UNLOCK_TTL_MS
    setCookie(c, cookieName(slug), signUnlock(services.config.secret, slug, expiresAt), {
      httpOnly: true,
      secure: services.config.publicUrl.startsWith('https://'),
      sameSite: 'Lax',
      // Scoped to the share routes, so it is never sent with an ordinary API call.
      path: '/api/v1/share',
      expires: new Date(expiresAt),
    })
    return c.json({ unlocked: true })
  })

  app.get('/:slug', async (c) => {
    const share = await open(c.get('services'), c.req.param('slug'), c)
    if (share === 'locked') return c.json({ locked: true }, 401)
    return c.json({
      locked: false,
      // A single photograph is carried as an album of one so the guards downstream
      // stay in one place, but the page should not call it an album to the visitor.
      kind: share.link.assetId ? 'photo' : 'album',
      album: share.album,
      allowDownload: share.link.allowDownload,
    })
  })

  app.get('/:slug/assets/:assetId/:variant{preview|thumbnail|original}', async (c) => {
    const services = c.get('services')
    const variant = c.req.param('variant') as 'preview' | 'thumbnail' | 'original'

    const share = await open(services, c.req.param('slug'), c)
    if (share === 'locked') throw unauthorized('This album is locked')

    if (variant === 'original' && !share.link.allowDownload) {
      throw notFound('Downloads are not enabled for this link')
    }

    // The asset must belong to the shared album. Otherwise a valid slug would be a
    // key to the whole library. Checked against the database, not `share.album.assets`
    // — that array is now a capped cover sample (see `openShare`), so scanning it would
    // wrongly reject a real photograph the sample happens to leave out. It was also an
    // O(n) scan run once per thumbnail, over an array that could hold every photo in
    // the album.
    const assetId = c.req.param('assetId')
    if (!(await isMemberOfShare(services, share, assetId))) {
      throw notFound('That photo is not part of this album')
    }

    const files = await services.db.select().from(assetFiles).where(eq(assetFiles.assetId, assetId))
    const file = files.find((f) => f.variant === variant)
    if (!file) throw notFound(`No ${variant} exists for that photo`)

    const store = variant === 'original' ? services.library : services.thumbnails
    return new Response(await store.read(file.path), {
      headers: {
        'Content-Type': file.mimeType,
        'Content-Length': String(file.sizeBytes),
        // Private: a shared photo must not be cached by an intermediary proxy.
        'Cache-Control': 'private, max-age=3600',
      },
    })
  })

  app.get('/:slug/timeline', async (c) => {
    const services = c.get('services')
    const share = await open(services, c.req.param('slug'), c)
    if (share === 'locked') throw unauthorized('This album is locked')

    // A visitor supplies only `covers`; the filter itself — which album, whose
    // library — is fixed by the share, never by anything the request carries. A photo
    // share (album.id is the link's own id, not a real album) simply has nothing to
    // match and answers with no buckets.
    const parsed = TimelineQuery.safeParse({ covers: c.req.query('covers') })
    if (!parsed.success) throw badRequest('Invalid query')

    const buckets = await services.assets.timeline(share.album.ownerId, {
      ...parsed.data,
      albumId: share.album.id,
    })
    return c.json({ buckets }, 200)
  })

  app.get('/:slug/timeline/bucket', async (c) => {
    const services = c.get('services')
    const share = await open(services, c.req.param('slug'), c)
    if (share === 'locked') throw unauthorized('This album is locked')

    const parsed = TimelineBucketQuery.safeParse({
      period: c.req.query('period'),
      cursor: c.req.query('cursor'),
      limit: c.req.query('limit'),
    })
    if (!parsed.success) throw badRequest('Invalid query')

    const page = await services.assets.bucket(share.album.ownerId, {
      ...parsed.data,
      albumId: share.album.id,
    })
    return c.json(page, 200)
  })

  return app
}

/**
 * Whether a photo belongs to the shared album — the guard for the asset route above.
 *
 * A photo share (`share.link.assetId` set) dresses a single asset as an album of one;
 * `share.album.id` there is the share link's own id, not a row in `albums`, so a photo
 * share is checked directly rather than against `album_assets`. It needs no deletedAt
 * or vaultedAt check of its own: `openShare` re-resolves a photo share on every
 * request through `openPhotoShare`, which already excludes a trashed or vaulted
 * asset — a trashed shared photo dissolves the share itself before `open()` below
 * ever reaches this guard.
 *
 * An album share has no such protection. Trashing a photo (`AssetService.trash`) only
 * sets `deletedAt` — the `album_assets` row survives, and so does `asset_files` until
 * the retention sweep runs, often weeks later. Vaulting happens to remove the
 * `album_assets` row today, in the same transaction, but that is `VaultService.moveIn`'s
 * behaviour, not something this guard should assume without checking. So membership
 * is judged against the same predicate `openShare` builds `share.album.assets` from
 * (see the `membership` condition in `AlbumService.openShare`), not against
 * `album_assets` alone: a row that points at a trashed or vaulted asset is not really
 * a member any more.
 */
async function isMemberOfShare(
  services: Services,
  share: OpenedShare,
  assetId: string,
): Promise<boolean> {
  if (share.link.assetId) return share.link.assetId === assetId

  const [member] = await services.db
    .select({ id: albumAssets.assetId })
    .from(albumAssets)
    .innerJoin(assets, eq(assets.id, albumAssets.assetId))
    .where(
      and(
        eq(albumAssets.albumId, share.album.id),
        eq(albumAssets.assetId, assetId),
        isNull(assets.deletedAt),
        isNull(assets.vaultedAt),
      ),
    )
    .limit(1)
  return member !== undefined
}

/** Resolves a share, requiring the unlock cookie when the album has a password. */
async function open(
  services: Services,
  slug: string,
  c: Parameters<typeof getCookie>[0],
): Promise<OpenedShare | 'locked'> {
  const share = await services.albums.openShare(slug)
  if (!share) throw notFound('This link is not valid, or it has expired')

  if (share.requiresPassword) {
    const token = getCookie(c, cookieName(slug))
    if (!verifyUnlock(services.config.secret, slug, token)) return 'locked'
  }

  return share
}
