import type {
  Asset,
  AssetFilter,
  AssetQuery,
  AssetSelection,
  AssetUpdate,
  LibraryStats,
  TimelineBucket,
  TimelineBucketQuery,
  TimelineQuery,
  TimelineTile,
} from '@imogen/shared'
import {
  and,
  asc,
  desc,
  eq,
  gte,
  inArray,
  isNotNull,
  isNull,
  lt,
  lte,
  notInArray,
  or,
  type SQL,
  sql,
} from 'drizzle-orm'
import type { Database } from '../db/index.ts'
import { albumAssets, assets, faces } from '../db/schema.ts'
import { badRequest, forbidden, notFound } from '../lib/errors.ts'
import { toAsset } from './serialize.ts'

/** Kept identical to the translate() in the generated search vector. */
const SEARCH_PUNCTUATION = '._-/\\'

export type AssetPage = {
  items: Asset[]
  nextCursor: string | null
  total: number | null
}

/**
 * A cursor is the sort key of the last row returned. Offsets would be wrong here: an
 * upload while the user is scrolling shifts every later page by one, so they would see
 * a photo twice and miss another.
 */
type Cursor = { value: string; id: string }

function encodeCursor(cursor: Cursor): string {
  return Buffer.from(JSON.stringify(cursor)).toString('base64url')
}

function decodeCursor(raw: string): Cursor | null {
  try {
    const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString()) as Cursor
    return typeof parsed?.value === 'string' && typeof parsed?.id === 'string' ? parsed : null
  } catch {
    return null
  }
}

/**
 * Scoping the caller supplies rather than the request does.
 *
 * `AssetFilter` is parsed from a query string, so anything expressible in it is
 * expressible by whoever is holding the URL. The vault must never be one of those
 * things — that is the whole of what the vault is — so "look inside the vault" lives
 * here instead, where only server code that has already checked the unlock can say it.
 */
export type AssetScope = { vaulted?: boolean }

export class AssetService {
  constructor(private readonly db: Database) {}

  async list(ownerId: string, query: AssetQuery): Promise<AssetPage> {
    const conditions = this.buildFilters(ownerId, query)
    const sortColumn =
      query.sort === 'createdAt'
        ? assets.createdAt
        : query.sort === 'filename'
          ? assets.originalFilename
          : assets.capturedAt
    const descending = query.order !== 'asc'

    const cursor = query.cursor ? decodeCursor(query.cursor) : null
    if (cursor) {
      // Tie-break on id so assets sharing a timestamp are neither skipped nor repeated.
      const boundary = descending
        ? or(
            sql`${sortColumn} < ${cursor.value}`,
            and(sql`${sortColumn} = ${cursor.value}`, sql`${assets.id} < ${cursor.id}`),
          )
        : or(
            sql`${sortColumn} > ${cursor.value}`,
            and(sql`${sortColumn} = ${cursor.value}`, sql`${assets.id} > ${cursor.id}`),
          )
      conditions.push(boundary!)
    }

    const order = descending
      ? [desc(sortColumn), desc(assets.id)]
      : [asc(sortColumn), asc(assets.id)]

    // Fetch one extra row to learn whether another page exists, without a second query.
    const rows = await this.db
      .select()
      .from(assets)
      .where(and(...conditions))
      .orderBy(...order)
      .limit(query.limit + 1)

    const hasMore = rows.length > query.limit
    const page = hasMore ? rows.slice(0, query.limit) : rows
    const last = page.at(-1)

    return {
      items: page.map(toAsset),
      nextCursor:
        hasMore && last
          ? encodeCursor({ value: this.cursorValue(last, query.sort), id: last.id })
          : null,
      total: null,
    }
  }

  private cursorValue(row: typeof assets.$inferSelect, sort: AssetQuery['sort']): string {
    if (sort === 'filename') return row.originalFilename
    const date = sort === 'createdAt' ? row.createdAt : row.capturedAt
    return date.toISOString()
  }

  private buildFilters(ownerId: string, query: AssetFilter, scope: AssetScope = {}): SQL[] {
    // The vault is not a filter anyone can turn off. Assets inside it are excluded from
    // every ordinary listing, search, and count; the only way to see them is through a
    // caller that asks for `scope.vaulted`, which is a SEPARATE ARGUMENT and not a field
    // of `AssetFilter` — so no request body can ever reach it, however it is parsed. The
    // vault's own routes set it after their own gate, the way the share routes fix
    // `albumId` from the link rather than from the request.
    const conditions: SQL[] = [
      eq(assets.ownerId, ownerId),
      scope.vaulted ? isNotNull(assets.vaultedAt) : isNull(assets.vaultedAt),
    ]

    conditions.push(query.trashed ? isNotNull(assets.deletedAt) : isNull(assets.deletedAt))

    // Archived photos stay out of the timeline unless explicitly requested. The vault is
    // not a timeline: it is everything you put there, and `VaultService.list` never made
    // the distinction, so a vaulted photograph that was archived on its way in must not
    // vanish from the one place its owner went looking for it.
    if (query.archived !== undefined) {
      conditions.push(eq(assets.archived, query.archived))
    } else if (!query.trashed && !scope.vaulted) {
      conditions.push(eq(assets.archived, false))
    }

    if (query.type) conditions.push(eq(assets.type, query.type))
    if (query.favorite !== undefined) conditions.push(eq(assets.favorite, query.favorite))
    if (query.takenAfter) conditions.push(gte(assets.capturedAt, new Date(query.takenAfter)))
    if (query.takenBefore) conditions.push(lte(assets.capturedAt, new Date(query.takenBefore)))

    if (query.albumId) {
      conditions.push(
        sql`exists (select 1 from ${albumAssets} where ${albumAssets.assetId} = ${assets.id} and ${albumAssets.albumId} = ${query.albumId})`,
      )
    }

    if (query.personId) {
      conditions.push(
        sql`exists (select 1 from ${faces} where ${faces.assetId} = ${assets.id} and ${faces.personId} = ${query.personId})`,
      )
    }

    if (query.bbox) {
      const [minLat, minLon, maxLat, maxLon] = query.bbox.split(',').map(Number)
      conditions.push(
        sql`${assets.latitude} between ${minLat} and ${maxLat} and ${assets.longitude} between ${minLon} and ${maxLon}`,
      )
    }

    if (query.q?.trim()) {
      // websearch_to_tsquery takes arbitrary user text: no escaping, no syntax errors.
      // The query must be punctuation-normalised exactly as the index is, or searching
      // "shot-3" compiles to 'shot' <-> '-3' and misses the indexed 'shot','3'.
      conditions.push(
        sql`${assets.searchVector} @@ websearch_to_tsquery('simple', translate(${query.q.trim()}, ${SEARCH_PUNCTUATION}, '     '))`,
      )
    }

    return conditions
  }

  /**
   * Fetching a single asset by id. Vaulted assets stay hidden unless the caller has
   * already proved the vault is unlocked — otherwise knowing an id would be enough to
   * read a photo somebody deliberately put away.
   */
  async get(ownerId: string, assetId: string, options: { includeVaulted?: boolean } = {}) {
    const [row] = await this.db.select().from(assets).where(eq(assets.id, assetId)).limit(1)
    if (!row) throw notFound('No such photo')
    if (row.ownerId !== ownerId) throw forbidden('That photo belongs to someone else')
    if (row.vaultedAt && !options.includeVaulted) {
      throw forbidden('That photo is in the vault')
    }
    return toAsset(row)
  }

  async update(ownerId: string, assetId: string, patch: AssetUpdate): Promise<Asset> {
    const current = await this.get(ownerId, assetId, { includeVaulted: true })

    const [row] = await this.db
      .update(assets)
      .set({
        ...(patch.favorite !== undefined ? { favorite: patch.favorite } : {}),
        ...(patch.archived !== undefined ? { archived: patch.archived } : {}),
        ...(patch.description !== undefined ? { description: patch.description } : {}),
        ...capturedAtChange(current, patch),
        ...(patch.location !== undefined
          ? {
              latitude: patch.location?.latitude ?? null,
              longitude: patch.location?.longitude ?? null,
              altitude: patch.location?.altitude ?? null,
              place: patch.location?.place ?? null,
            }
          : {}),
        updatedAt: new Date(),
      })
      .where(eq(assets.id, assetId))
      .returning()
    return toAsset(row!)
  }

  /** Soft delete. Nothing is destroyed until the retention sweep runs. */
  async trash(ownerId: string, assetIds: string[]): Promise<number> {
    if (assetIds.length === 0) return 0
    const rows = await this.db
      .update(assets)
      .set({ deletedAt: new Date(), updatedAt: new Date() })
      .where(
        and(eq(assets.ownerId, ownerId), inArray(assets.id, assetIds), isNull(assets.deletedAt)),
      )
      .returning({ id: assets.id })
    return rows.length
  }

  async restore(ownerId: string, assetIds: string[]): Promise<number> {
    if (assetIds.length === 0) return 0
    const rows = await this.db
      .update(assets)
      .set({ deletedAt: null, updatedAt: new Date() })
      .where(and(eq(assets.ownerId, ownerId), inArray(assets.id, assetIds)))
      .returning({ id: assets.id })
    return rows.length
  }

  /**
   * The rows a selection means, as conditions rather than as ids. The whole point is that
   * a hundred thousand photographs never become a hundred thousand uuids — not in a
   * request body, not in a Set, and not in an `in` list.
   *
   * The invariant across both branches, which is the same one `resolveSelection` states
   * below: A QUERY MAY NEVER REACH THE VAULT; AN EXPLICIT ID LIST MAY. A query is parsed
   * from a URL, so anything it can express is expressible by whoever holds the URL, and
   * the vault is precisely the thing no URL may reach — the query branch gets that from
   * `buildFilters` and it is not repeated here. An id list is the opposite act: the caller
   * is naming one photograph it already had to get past the vault's own gate to see, and
   * the vault's viewer trashes exactly that way. Excluding the vault here too made that
   * button match zero rows, answer `{count: 0}`, and say nothing about it.
   *
   * Ownership is checked on both branches regardless: knowing an id is not owning it.
   */
  private selectionConditions(ownerId: string, selection: AssetSelection): SQL[] {
    if (selection.assetIds) {
      return [eq(assets.ownerId, ownerId), inArray(assets.id, selection.assetIds)]
    }
    const conditions = this.buildFilters(ownerId, selection.query!)
    if (selection.except?.length) conditions.push(notInArray(assets.id, selection.except))
    return conditions
  }

  async trashSelection(ownerId: string, selection: AssetSelection): Promise<number> {
    const rows = await this.db
      .update(assets)
      .set({ deletedAt: new Date(), updatedAt: new Date() })
      .where(and(...this.selectionConditions(ownerId, selection), isNull(assets.deletedAt)))
      .returning({ id: assets.id })
    return rows.length
  }

  /**
   * `isNotNull(assets.deletedAt)` is the mirror of the `isNull` guard `trashSelection`
   * carries, and it is load-bearing twice over: without it an id list of ten photographs
   * of which two were in the trash cleared `deletedAt` on all ten, gave the other eight a
   * fresh `updatedAt` for nothing, and answered `{count: 10}` — which is the number the UI
   * reads back to the reader. The count has to be what was actually restored.
   *
   * The weaker sibling of the vault move-out gap survives it: a `query`-form selection with
   * no `trashed: true` inherits `isNull(assets.deletedAt)` from `buildFilters`'s untrashed
   * default and so contradicts the guard below, matching nothing — a silent no-op rather
   * than a rejected request. Left as-is: unlike vault move-out, `trashed: true` gives a
   * query a real, correct way to mean "the trash", so there is no case that can only fail.
   */
  async restoreSelection(ownerId: string, selection: AssetSelection): Promise<number> {
    const rows = await this.db
      .update(assets)
      .set({ deletedAt: null, updatedAt: new Date() })
      .where(and(...this.selectionConditions(ownerId, selection), isNotNull(assets.deletedAt)))
      .returning({ id: assets.id })
    return rows.length
  }

  /**
   * The ids a selection means. Trash and restore act by condition, but album membership
   * is a join table and the vault's move routes touch faces by asset id — both genuinely
   * need ids, resolved server-side over the same conditions rather than round-tripping
   * a filter's results back through the client first.
   *
   * An explicit id list passes straight through, unfiltered — not even the ownership check
   * `selectionConditions` applies. That is deliberate, not lazy: the caller already owns
   * the ownership and vault checks that matter for its own operation (`addAssets`,
   * `moveIn`, `moveOut`), the same as before this existed. Moving photographs *out* of the
   * vault sends exactly the ids of vaulted assets, which is the same reason the id branch
   * of `selectionConditions` no longer excludes the vault either.
   *
   * Ordered `capturedAt desc, id desc` — the same order as every other listing here,
   * matching `assets_timeline_idx`. A caller that chunks this result (album membership,
   * vault move-in) relies on that: each batch is a contiguous slice of the same order,
   * so the newest matched asset always lands in the first batch, whatever the batch
   * size. Without it, an album's derived cover — the lowest `album_assets.position`,
   * assigned in the order batches are processed — would point at "newest within an
   * arbitrary slice" instead of newest overall for any selection over one batch.
   */
  async resolveSelection(ownerId: string, selection: AssetSelection): Promise<string[]> {
    if (selection.assetIds) return selection.assetIds
    const rows = await this.db
      .select({ id: assets.id })
      .from(assets)
      .where(and(...this.selectionConditions(ownerId, selection)))
      .orderBy(desc(assets.capturedAt), desc(assets.id))
    return rows.map((r) => r.id)
  }

  async timeline(
    ownerId: string,
    query: TimelineQuery = {},
    scope: AssetScope = {},
  ): Promise<TimelineBucket[]> {
    const conditions = this.buildFilters(ownerId, query, scope)
    const day = sql<string>`to_char(${assets.capturedAt} at time zone 'UTC', 'YYYY-MM-DD')`

    const rows = await this.db
      .select({
        date: day,
        count: sql<number>`count(*)::int`,
        /*
         * The newest ready asset in the day, or nothing. A period whose photographs are
         * all still being processed shows a count without a picture rather than
         * disappearing from an overview.
         */
        coverAssetId: query.covers
          ? sql<
              string | null
            >`(array_agg(${assets.id} order by ${assets.capturedAt} desc, ${assets.id} desc) filter (where ${assets.status} = 'ready'))[1]`
          : sql<string | null>`null::uuid`,
      })
      .from(assets)
      .where(and(...conditions))
      .groupBy(day)
      .orderBy(sql`1 desc`)

    return rows.map((r) => ({
      date: r.date,
      count: Number(r.count),
      coverAssetId: r.coverAssetId ?? null,
    }))
  }

  /**
   * Every tile in one period, in one answer. The projection is deliberate: a grid draws
   * ten fields and an `Asset` carries twenty-five, and over a heavy month that is the
   * difference between one round trip and several.
   */
  async bucket(ownerId: string, query: TimelineBucketQuery, scope: AssetScope = {}) {
    const { start, end } = periodBounds(query.period)
    // The condition set every query in this method starts from. A cursor predicate is
    // added only for the page query, below — never mutated onto this array — so the
    // count query can reuse it unmodified and stay the period total rather than
    // shrinking as the caller pages through.
    const base = [
      ...this.buildFilters(ownerId, query, scope),
      gte(assets.capturedAt, start),
      lt(assets.capturedAt, end),
    ]

    const after = query.cursor ? decodeCursor(query.cursor) : null
    const paged = after
      ? [
          ...base,
          sql`(${assets.capturedAt}, ${assets.id}) < (${new Date(after.value)}, ${after.id})`,
        ]
      : base

    const rows = await this.db
      .select(TILE_COLUMNS)
      .from(assets)
      .where(and(...paged))
      .orderBy(desc(assets.capturedAt), desc(assets.id))
      .limit(query.limit + 1)

    const hasMore = rows.length > query.limit
    const page = hasMore ? rows.slice(0, query.limit) : rows
    const last = page.at(-1)

    /*
     * The count is cheap here and the client wants it: a period's total is what sizes the
     * segment before its tiles arrive, and re-deriving it from the day buckets would be
     * one more thing to keep in step.
     */
    const [counted] = await this.db
      .select({ total: sql<number>`count(*)::int` })
      .from(assets)
      .where(and(...base))

    return {
      items: page.map(toTile),
      nextCursor:
        hasMore && last
          ? encodeCursor({ value: last.capturedAt.toISOString(), id: last.id })
          : null,
      total: Number(counted?.total ?? 0),
    }
  }

  async stats(ownerId: string): Promise<LibraryStats> {
    const live = and(eq(assets.ownerId, ownerId), isNull(assets.deletedAt))
    const [row] = await this.db
      .select({
        assetCount: sql<number>`count(*) filter (where ${assets.deletedAt} is null)::int`,
        imageCount: sql<number>`count(*) filter (where ${assets.deletedAt} is null and ${assets.type} = 'image')::int`,
        videoCount: sql<number>`count(*) filter (where ${assets.deletedAt} is null and ${assets.type} = 'video')::int`,
        favoriteCount: sql<number>`count(*) filter (where ${assets.deletedAt} is null and ${assets.favorite})::int`,
        trashedCount: sql<number>`count(*) filter (where ${assets.deletedAt} is not null)::int`,
        storageBytes: sql<number>`coalesce(sum(${assets.sizeBytes}) filter (where ${assets.deletedAt} is null), 0)::bigint`,
        earliest: sql<Date | null>`min(${assets.capturedAt}) filter (where ${assets.deletedAt} is null)`,
        latest: sql<Date | null>`max(${assets.capturedAt}) filter (where ${assets.deletedAt} is null)`,
      })
      .from(assets)
      .where(and(eq(assets.ownerId, ownerId), isNull(assets.vaultedAt)))

    const [albumRow] = await this.db
      .select({ count: sql<number>`count(*)::int` })
      .from(sql`albums`)
      .where(sql`albums.owner_id = ${ownerId}`)

    void live
    return {
      assetCount: Number(row?.assetCount ?? 0),
      imageCount: Number(row?.imageCount ?? 0),
      videoCount: Number(row?.videoCount ?? 0),
      albumCount: Number(albumRow?.count ?? 0),
      favoriteCount: Number(row?.favoriteCount ?? 0),
      trashedCount: Number(row?.trashedCount ?? 0),
      storageBytes: Number(row?.storageBytes ?? 0),
      earliestCapturedAt: row?.earliest ? new Date(row.earliest).toISOString() : null,
      latestCapturedAt: row?.latest ? new Date(row.latest).toISOString() : null,
    }
  }
}

const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]

const isLeapYear = (year: number) => (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0

const daysInMonth = (year: number, month: number) =>
  month === 2 && isLeapYear(year) ? 29 : DAYS_IN_MONTH[month - 1]!

/**
 * `2011-08` is a month; `2011-08-14` is a day. Both are half-open, both in UTC.
 *
 * The range check is here rather than on the schema because `TimelineBucketQuery` lives in
 * the SDK and its regex only counts digits: `2011-13` and `2011-02-30` both satisfy it.
 * `Date.UTC` then rolls them over silently, so the endpoint answered 200 with January
 * 2012's tiles and a total to match — a client's off-by-one turned into wrong data rather
 * than a rejected request, which is the one outcome worth ruling out. A 400 here reads on
 * the wire exactly like the zod failures `defaultHook` produces.
 */
function periodBounds(period: string): { start: Date; end: Date } {
  const [year, month, day] = period.split('-').map(Number)
  const inRange =
    Number.isInteger(year) &&
    // `Date.UTC` reads a year of 0 to 99 as 1900 to 1999, so '0011-08' would quietly become
    // August 1911 and answer 200 with a stranger's decade. The same silent rollover the
    // month and day checks below exist to prevent, reached through the year instead. The
    // upper bound matches the four digits the schema accepts, so nothing that gets this far
    // can exceed it — but it is stated rather than assumed, because the day this is derived
    // from a looser shape is the day it starts mapping into years `Date` cannot hold.
    year! >= 100 &&
    year! <= 9999 &&
    Number.isInteger(month) &&
    month! >= 1 &&
    month! <= 12 &&
    (day === undefined || (Number.isInteger(day) && day >= 1 && day <= daysInMonth(year!, month!)))
  if (!inRange) {
    throw badRequest(`"${period}" is not a month or a day that exists`)
  }

  if (day === undefined) {
    return {
      start: new Date(Date.UTC(year!, month! - 1, 1)),
      end: new Date(Date.UTC(year!, month!, 1)),
    }
  }
  return {
    start: new Date(Date.UTC(year!, month! - 1, day)),
    end: new Date(Date.UTC(year!, month! - 1, day + 1)),
  }
}

/**
 * Exactly the columns a tile draws. `bucket()` selects only these — up to `limit + 1`
 * rows per call — rather than every column on `assets`, which would drag TOASTed exif
 * json, the search vector, and a 512-dimension embedding across the wire for nothing.
 */
const TILE_COLUMNS = {
  id: assets.id,
  capturedAt: assets.capturedAt,
  width: assets.width,
  height: assets.height,
  type: assets.type,
  status: assets.status,
  favorite: assets.favorite,
  duration: assets.duration,
  placeholderColor: assets.placeholderColor,
  livePhotoVideoId: assets.livePhotoVideoId,
}

type TileRow = Pick<typeof assets.$inferSelect, keyof typeof TILE_COLUMNS>

function toTile(row: TileRow): TimelineTile {
  return {
    id: row.id,
    capturedAt: row.capturedAt.toISOString(),
    width: row.width,
    height: row.height,
    type: row.type,
    status: row.status,
    favorite: row.favorite,
    duration: row.duration,
    placeholderColor: row.placeholderColor,
    livePhotoVideoId: row.livePhotoVideoId,
  }
}

/**
 * Correcting a capture date without losing the one the photo arrived with.
 *
 * Scanned photographs and files stripped of their metadata turn up under the wrong
 * date, and the only person who knows the right one is the owner. The correction is
 * recorded against the row alone — the uploaded file is never rewritten, so whatever
 * the camera wrote stays on disk untouched.
 *
 * The first correction tucks the imported date away so it can be put back. Later
 * corrections leave it alone: what is worth keeping is what the file said, not the
 * previous guess at fixing it.
 */
function capturedAtChange(current: Asset, patch: AssetUpdate) {
  if (patch.resetCapturedAt) {
    if (!current.capturedAtOriginal) return {}
    return {
      capturedAt: new Date(current.capturedAtOriginal),
      capturedAtIsExact: current.capturedAtOriginalIsExact ?? false,
      capturedAtOriginal: null,
      capturedAtOriginalIsExact: null,
    }
  }

  if (!patch.capturedAt) return {}

  return {
    capturedAt: new Date(patch.capturedAt),
    // A date the owner typed is as exact as this library gets.
    capturedAtIsExact: true,
    ...(current.capturedAtOriginal
      ? {}
      : {
          capturedAtOriginal: new Date(current.capturedAt),
          capturedAtOriginalIsExact: current.capturedAtIsExact,
        }),
  }
}
