# Timeline Scrubbing and Windowed Rendering — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the web and terminal clients a day-bucket spine and a lean per-period tile endpoint, so both can render a windowed grid over a twenty-year library and scrub to any date without loading what lies between.

**Architecture:** One aggregate (`GET /assets/timeline`, already present) tells a client the shape of the whole timeline; one new endpoint (`GET /assets/timeline/bucket`) returns a lean `TimelineTile` for every asset in a period. A pure geometry module turns buckets plus loaded tiles into an absolute segment table, which drives windowed rendering, a density-proportional date rail, and a zoomed-out overview. Bulk mutations gain a by-query selection form so "select all" never materialises a hundred thousand uuids.

**Tech Stack:** Bun, Hono + `@hono/zod-openapi`, Drizzle, Postgres 17, React 19 + TanStack Query + Tailwind, Rust + ratatui + tokio, and five SDK ports (TypeScript, Rust, Python, Swift, Kotlin) governed by `imogen-sdk/conformance/*.json`.

**Spec:** `imogen-server/docs/superpowers/specs/2026-08-27-timeline-scrubbing-design.md` — read it before Task 1. The plan argues from the spec; where they disagree, the spec wins and the plan is wrong.

## Global Constraints

- **Three repositories, three worktrees, sibling layout.** `imogen-server` and `imogen-cli` reference the SDK by relative path (`file:../imogen-sdk/typescript/packages/shared`, `path = "../imogen-sdk/rust"`). Worktrees live at `~/src/imogen-timeline/{imogen-sdk,imogen-server,imogen-cli}` with exactly those directory names. A worktree nested inside a repository breaks path resolution.
- **Branch name in all three repositories:** `timeline-scrubbing`.
- **Phase 0 lands before any fan-out.** Every later task reads field names from `conformance/models.json` and `conformance/endpoints.json`. Do not invent a field name; if one is missing, stop and say so.
- **Backwards compatibility is not optional.** `GET /assets/timeline` with no parameters must return exactly what it returns today. `IdsBody` callers of every bulk route must keep working. `AlbumWithAssets.assets` and `PersonWithPhotos.photos` stay in the contract.
- **Field naming is camelCase on the wire**, spelled out in full — never abbreviated to single letters.
- **Ordering is `capturedAt desc, id desc` everywhere**, matching `assets_timeline_idx`.
- **Day boundaries are UTC on both sides.** Server groups with `at time zone 'UTC'`; the web's `groupByDay` uses `capturedAt.slice(0, 10)`. Do not change either without changing both.
- **TDD.** Every task writes a failing test first, watches it fail, then implements. No exceptions.
- **Verification gate per repository:** `bun run verify` in `imogen-sdk` and `imogen-server`; `cargo test && cargo clippy -- -D warnings` in `imogen-cli`. A task is not done until its repository's gate passes.
- **Commit style:** the repositories use a sentence-style subject and an explanatory body. Match the surrounding log. Every commit ends with `Co-Authored-By: Claude with claude-opus-5[1m]`.

---

## File Structure

**`imogen-sdk`**
- Modify `conformance/endpoints.json` — add `assets.timelineBucket`.
- Modify `conformance/models.json` — add `timelineTile`, extend `timelineBucket` with `coverAssetId`.
- Modify `typescript/packages/shared/src/query.ts` — `AssetFilter`, `TimelineTile`, `TimelineQuery`, `TimelineBucketQuery`, `AssetSelection`; `TimelineBucket` gains `coverAssetId`; `AssetQuery` is rebuilt from `AssetFilter`.
- Modify `typescript/packages/shared/src/index.ts` — export the new symbols.
- Modify `typescript/packages/sdk/src/assets.ts` — `timeline(query)`, `timelineBucket(query)`, selection-shaped `trash`/`restore`.
- Modify `rust/src/models.rs`, `rust/src/assets.rs`, `rust/src/albums.rs`, `rust/src/vault.rs`.
- Modify `python/src/imogen_sdk/models.py`, `python/src/imogen_sdk/resources.py`.
- Modify the Swift and Kotlin sources in the same shape.

**`imogen-server`**
- Modify `packages/server/src/media/assets.ts` — `timeline()` gains filters and covers; new `bucket()`; new `trashSelection()`/`restoreSelection()`; `buildFilters` accepts `AssetFilter` and learns `personId`.
- Modify `packages/server/src/api/assets.ts` — the two timeline routes, selection bodies on `/trash` and `/restore`.
- Modify `packages/server/src/api/albums.ts`, `packages/server/src/api/vault.ts` — selection bodies.
- Modify `packages/server/src/media/albums.ts` — cap and order the cover sample.
- Modify `packages/server/src/faces/faces.ts` — order `photosOf`; add `forgetAssets`.
- Modify `packages/server/src/api/share.ts` — `exists` guard, scoped bucket route.
- Create `packages/web/src/lib/timelineLayout.ts` and `timelineLayout.test.ts` — pure geometry.
- Create `packages/web/src/hooks/useTimeline.ts` — buckets, tile windows, eviction, pending poll.
- Create `packages/web/src/components/TimelineRail.tsx` and `TimelineOverview.tsx`.
- Modify `packages/web/src/components/PhotoGrid.tsx` — windowed renderer.
- Modify `packages/web/src/routes/Timeline.tsx`, `AlbumDetail.tsx`, `PersonDetail.tsx`, `SharedAlbum.tsx`, `VaultRoute.tsx`.
- Modify `packages/web/src/hooks/useSelection.ts` — scope flag plus exclusion set.

**`imogen-cli`**
- Modify `src/tui/app.rs` — buckets, tile window, LRU thumbnails, global-index navigation, `Mode::JumpDate`.
- Modify `src/tui/mod.rs` — bucket-driven fetch, jump handling.
- Modify `src/tui/ui.rs` — year rail gutter, jump prompt.

---

# Phase −1 — Setup

Done once, before Task 1, by whoever is driving the plan.

- [ ] **Create the three worktrees, as siblings with these exact names**

```bash
mkdir -p ~/src/imogen-timeline
git -C ~/src/imogen/imogen-sdk    worktree add ~/src/imogen-timeline/imogen-sdk    -b timeline-scrubbing
git -C ~/src/imogen/imogen-server worktree add ~/src/imogen-timeline/imogen-server -b timeline-scrubbing
git -C ~/src/imogen/imogen-cli    worktree add ~/src/imogen-timeline/imogen-cli    -b timeline-scrubbing
```

The names matter: `imogen-server` resolves `file:../imogen-sdk/typescript/packages/shared` and `imogen-cli` resolves `path = "../imogen-sdk/rust"` relative to their own directory, so the three must sit beside each other under one parent and be spelled exactly this way.

- [ ] **Install dependencies in each**

```bash
cd ~/src/imogen-timeline/imogen-sdk/typescript && bun install
cd ~/src/imogen-timeline/imogen-server && bun install
```

- [ ] **Confirm each worktree is green before changing anything**

```bash
cd ~/src/imogen-timeline/imogen-sdk/typescript && bun run verify
cd ~/src/imogen-timeline/imogen-server && bun run verify
cd ~/src/imogen-timeline/imogen-cli && cargo test
```

A failure here is a pre-existing one and must be understood before it gets blamed on this work.

---

# Phase 0 — The contract

Repository: `imogen-sdk`. Serial. Nothing else starts until this is committed.

### Task 1: Contract schemas and conformance fixtures

**Files:**
- Modify: `conformance/endpoints.json`
- Modify: `conformance/models.json`
- Modify: `typescript/packages/shared/src/query.ts`
- Modify: `typescript/packages/shared/src/index.ts`
- Test: `typescript/packages/shared/src/query.test.ts` (create)

**Interfaces:**
- Consumes: `AssetType` and `AssetStatus` from `./asset.ts`; `PageQuery`, `pageOf` already in `query.ts`.
- Produces, and every later task depends on these exact names:
  - `AssetFilter` — `{ q?, type?, albumId?, personId?, favorite?, archived?, trashed?, takenAfter?, takenBefore?, bbox? }`
  - `AssetQuery` — `PageQuery + AssetFilter + { sort, order }` (unchanged on the wire, now composed)
  - `TimelineTile` — `{ id, capturedAt, width, height, type, status, favorite, duration, placeholderColor, livePhotoVideoId }`
  - `TimelineBucket` — `{ date, count, coverAssetId }`
  - `TimelineQuery` — `AssetFilter + { covers?: boolean }`
  - `TimelineBucketQuery` — `AssetFilter + { period: string, cursor?: string, limit: number }`
  - `AssetSelection` — `{ assetIds?, query?, except? }`, exactly one of `assetIds` / `query`

- [ ] **Step 1: Write the failing test**

Create `typescript/packages/shared/src/query.test.ts`:

```ts
import { describe, expect, test } from 'bun:test'
import { AssetFilter, AssetSelection, TimelineBucket, TimelineBucketQuery, TimelineTile } from './query.ts'

describe('AssetFilter', () => {
  test('carries every filter the timeline endpoints share', () => {
    const parsed = AssetFilter.parse({ q: 'harbour', personId: '6a5f1e2c-90b4-4d1a-8f3e-2b7c9d0a1e45' })
    expect(parsed.q).toBe('harbour')
    expect(parsed.personId).toBe('6a5f1e2c-90b4-4d1a-8f3e-2b7c9d0a1e45')
  })

  test('rejects a bbox that is not four numbers', () => {
    expect(() => AssetFilter.parse({ bbox: '1,2,3' })).toThrow()
  })
})

describe('TimelineBucket', () => {
  test('defaults coverAssetId to null, so a caller that did not ask still parses', () => {
    expect(TimelineBucket.parse({ date: '2011-08-14', count: 12 }).coverAssetId).toBeNull()
  })
})

describe('TimelineTile', () => {
  test('accepts a still-processing asset with no dimensions', () => {
    const tile = TimelineTile.parse({
      id: '6a5f1e2c-90b4-4d1a-8f3e-2b7c9d0a1e45',
      capturedAt: '2011-08-14T09:30:00.000Z',
      width: null,
      height: null,
      type: 'image',
      status: 'processing',
      favorite: false,
      duration: null,
      placeholderColor: null,
      livePhotoVideoId: null,
    })
    expect(tile.status).toBe('processing')
  })
})

describe('TimelineBucketQuery', () => {
  test('accepts a month and a day', () => {
    expect(TimelineBucketQuery.parse({ period: '2011-08' }).period).toBe('2011-08')
    expect(TimelineBucketQuery.parse({ period: '2011-08-14' }).period).toBe('2011-08-14')
  })

  test('rejects a bare year, which would be a whole-library scan by accident', () => {
    expect(() => TimelineBucketQuery.parse({ period: '2011' })).toThrow()
  })

  test('defaults the limit to 5000', () => {
    expect(TimelineBucketQuery.parse({ period: '2011-08' }).limit).toBe(5000)
  })
})

describe('AssetSelection', () => {
  test('takes an explicit id list', () => {
    const parsed = AssetSelection.parse({ assetIds: ['6a5f1e2c-90b4-4d1a-8f3e-2b7c9d0a1e45'] })
    expect(parsed.assetIds).toHaveLength(1)
  })

  test('takes a query with exclusions', () => {
    const parsed = AssetSelection.parse({
      query: { favorite: true },
      except: ['6a5f1e2c-90b4-4d1a-8f3e-2b7c9d0a1e45'],
    })
    expect(parsed.query?.favorite).toBe(true)
    expect(parsed.except).toHaveLength(1)
  })

  test('refuses both forms at once', () => {
    expect(() => AssetSelection.parse({ assetIds: ['6a5f1e2c-90b4-4d1a-8f3e-2b7c9d0a1e45'], query: {} })).toThrow()
  })

  test('refuses neither form', () => {
    expect(() => AssetSelection.parse({})).toThrow()
  })
})
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `cd ~/src/imogen-timeline/imogen-sdk/typescript && bun test packages/shared/src/query.test.ts`
Expected: FAIL — `AssetFilter` is not exported from `./query.ts`.

- [ ] **Step 3: Rebuild `query.ts` around `AssetFilter`**

In `typescript/packages/shared/src/query.ts`, import `AssetStatus` alongside the existing `AssetType`, then replace the body of `AssetQuery` with a composed form and add the new schemas. Keep every existing comment; they explain decisions that still hold.

```ts
import { z } from 'zod'
import { AssetStatus, AssetType } from './asset.ts'

/**
 * The filters every listing shares. Extracted so the timeline aggregate, the bucket
 * endpoint, and a by-query selection cannot drift from what `GET /assets` accepts —
 * three definitions of "which photographs" is three chances to disagree.
 */
export const AssetFilter = z.object({
  /** Free-text over filename, description, camera, and place. */
  q: z.string().max(512).optional(),
  type: AssetType.optional(),
  albumId: z.uuid().optional(),
  /** Photographs a given person appears in. */
  personId: z.uuid().optional(),
  favorite: z.coerce.boolean().optional(),
  archived: z.coerce.boolean().optional(),
  /** When true, returns only trashed assets. Trashed assets are hidden otherwise. */
  trashed: z.coerce.boolean().optional(),
  takenAfter: z.iso.datetime().optional(),
  takenBefore: z.iso.datetime().optional(),
  /** Bounding box filter: minLat,minLon,maxLat,maxLon */
  bbox: z
    .string()
    .regex(/^-?\d+(\.\d+)?(,-?\d+(\.\d+)?){3}$/, 'expected minLat,minLon,maxLat,maxLon')
    .optional(),
})
export type AssetFilter = z.infer<typeof AssetFilter>

export const AssetQuery = PageQuery.extend(AssetFilter.shape).extend({
  sort: AssetSort.default('capturedAt'),
  order: z.enum(['asc', 'desc']).default('desc'),
})
export type AssetQuery = z.infer<typeof AssetQuery>

/** A day bucket in the timeline, used to size the scroller before assets load. */
export const TimelineBucket = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  count: z.number().int().positive(),
  /**
   * The newest ready asset in the bucket, for an overview's period card. Null unless
   * `covers` was asked for, and null for a period whose photographs are all still being
   * processed — such a period shows a count without a picture rather than vanishing.
   */
  coverAssetId: z.uuid().nullable().default(null),
})
export type TimelineBucket = z.infer<typeof TimelineBucket>

export const TimelineQuery = AssetFilter.extend({
  covers: z.coerce.boolean().optional(),
})
export type TimelineQuery = z.infer<typeof TimelineQuery>

/**
 * Everything a grid tile draws, and nothing else. An `Asset` carries checksum, exif,
 * filenames, and both captured-at corrections — around 800 bytes against this one's
 * 200 — none of which a tile reads. Over a heavy month that is the difference between
 * one round trip and several.
 */
export const TimelineTile = z.object({
  id: z.uuid(),
  capturedAt: z.iso.datetime(),
  width: z.number().int().positive().nullable(),
  height: z.number().int().positive().nullable(),
  type: AssetType,
  status: AssetStatus,
  favorite: z.boolean(),
  duration: z.number().nonnegative().nullable(),
  placeholderColor: z.string().nullable(),
  livePhotoVideoId: z.uuid().nullable(),
})
export type TimelineTile = z.infer<typeof TimelineTile>

export const TimelineBucketQuery = AssetFilter.extend({
  /**
   * `YYYY-MM` or `YYYY-MM-DD`. A bare year is refused: it would be a whole-library scan
   * asked for by accident.
   */
  period: z.string().regex(/^\d{4}-\d{2}(-\d{2})?$/, 'expected YYYY-MM or YYYY-MM-DD'),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(10_000).default(5000),
})
export type TimelineBucketQuery = z.infer<typeof TimelineBucketQuery>

/**
 * What a bulk mutation acts on. Either an explicit list, or the filter the user was
 * looking at minus whatever they unticked — so "select all" in a hundred-thousand-photo
 * library is a filter, not a hundred thousand uuids in a request body.
 *
 * Two optional fields and a refinement rather than a discriminated union: a union costs
 * a Rust enum, a Swift enum with associated values, and a Kotlin sealed class, and buys
 * nothing.
 */
export const AssetSelection = z
  .object({
    assetIds: z.array(z.uuid()).min(1).max(1000).optional(),
    query: AssetFilter.optional(),
    /** Capped deliberately: past this, an interface should not be offering a selection. */
    except: z.array(z.uuid()).max(10_000).optional(),
  })
  .refine((value) => (value.assetIds === undefined) !== (value.query === undefined), {
    message: 'Provide exactly one of assetIds or query',
  })
export type AssetSelection = z.infer<typeof AssetSelection>
```

Note the ordering constraint: `AssetSort` and `PageQuery` are declared above `AssetQuery` in the existing file, and `AssetFilter` must be declared before `AssetQuery` uses its `.shape`. Move declarations rather than adding forward references.

- [ ] **Step 4: Export the new symbols**

In `typescript/packages/shared/src/index.ts`, add `AssetFilter`, `AssetSelection`, `TimelineQuery`, `TimelineBucketQuery`, and `TimelineTile` beside the existing `TimelineBucket` export, as both value and type wherever the file does so for its neighbours.

- [ ] **Step 5: Run the test and watch it pass**

Run: `cd ~/src/imogen-timeline/imogen-sdk/typescript && bun test packages/shared/src/query.test.ts`
Expected: PASS, all cases.

- [ ] **Step 6: Add the endpoint to the conformance table**

In `conformance/endpoints.json`, inside `resources.assets`, immediately after the `timeline` row:

```json
{ "operation": "timelineBucket", "method": "GET", "path": "/api/v1/assets/timeline/bucket" },
```

- [ ] **Step 7: Add the model fixtures**

In `conformance/models.json`, extend the existing `timelineBucket` payload with `"coverAssetId": "6a5f1e2c-90b4-4d1a-8f3e-2b7c9d0a1e45"` and assert it, then add a sibling entry:

```json
"timelineTile": {
  "payload": {
    "id": "6a5f1e2c-90b4-4d1a-8f3e-2b7c9d0a1e45",
    "capturedAt": "2011-08-14T09:30:00.000Z",
    "width": 4032,
    "height": 3024,
    "type": "image",
    "status": "ready",
    "favorite": true,
    "duration": null,
    "placeholderColor": "#3b5f7a",
    "livePhotoVideoId": null
  },
  "assert": {
    "id": "6a5f1e2c-90b4-4d1a-8f3e-2b7c9d0a1e45",
    "capturedAt": "2011-08-14T09:30:00.000Z",
    "width": 4032,
    "height": 3024,
    "type": "image",
    "status": "ready",
    "favorite": true,
    "duration": null,
    "placeholderColor": "#3b5f7a",
    "livePhotoVideoId": null
  }
}
```

If `timelineBucket` has no entry in `models.json` today, add one in the same shape with `date`, `count`, and `coverAssetId`.

- [ ] **Step 8: Confirm the ports now fail, which is the point**

Run: `cd ~/src/imogen-timeline/imogen-sdk/typescript && bun run verify`
Expected: PASS — TypeScript is the port that just moved.

The Rust, Python, Swift, and Kotlin conformance tests are now expected to FAIL, because they walk these two files and do not yet declare `timelineBucket` or `TimelineTile`. That failure is the work order for Phase 1. Record the failure text; do not fix it here.

- [ ] **Step 9: Commit**

```bash
cd ~/src/imogen-timeline/imogen-sdk
git add conformance/endpoints.json conformance/models.json typescript/packages/shared/src/
git commit -m "$(cat <<'MSG'
Add the timeline bucket contract

Three endpoints want the same answer to "which photographs" — the day
aggregate, the new per-period tile fetch, and a bulk mutation acting on a
query rather than a list of ids. AssetFilter is that answer, written once,
with AssetQuery now composed from it.

TimelineTile is what a grid tile actually draws. An Asset carries checksum,
exif, filenames and both captured-at corrections, four times the bytes, none
of which a tile reads.

The four other ports now fail conformance, which is the work order for them.

Co-Authored-By: Claude with claude-opus-5[1m]
MSG
)"
```

---

# Phase 1 — The five ports

Repository: `imogen-sdk`. Tasks 2 through 6 touch disjoint directories and run in parallel.

Every port has an existing `timeline()` method and an existing `TimelineBucket` model. **Mirror them exactly** — the same file, the same visibility, the same error handling, the same doc-comment voice. The conformance test in each port already walks `endpoints.json` and `models.json`; making it pass is the definition of done.

### Task 2: TypeScript port

**Files:**
- Modify: `typescript/packages/sdk/src/assets.ts`
- Modify: `typescript/packages/sdk/src/albums.ts`
- Modify: `typescript/packages/sdk/src/vault.ts`
- Modify: `typescript/packages/sdk/src/index.ts`
- Test: the existing conformance test under `typescript/packages/sdk/`

**Interfaces:**
- Consumes: `AssetFilter`, `AssetSelection`, `TimelineBucket`, `TimelineBucketQuery`, `TimelineQuery`, `TimelineTile` from `@imogen/shared`.
- Produces:
  - `Assets.timeline(query?: Partial<TimelineQuery>): Promise<{ buckets: TimelineBucket[] }>`
  - `Assets.timelineBucket(query: TimelineBucketQuery): Promise<TilePage>` where `TilePage = { items: TimelineTile[]; nextCursor: string | null; total: number | null }`
  - `Assets.trash(selection: string[] | AssetSelection): Promise<{ count: number }>`
  - `Assets.restore(selection: string[] | AssetSelection): Promise<{ count: number }>`
  - `Albums.addAssets(albumId, selection: string[] | AssetSelection)`, `Albums.removeAssets(...)` in the same shape
  - `Vault.moveIn(selection)`, `Vault.moveOut(selection)` in the same shape

- [ ] **Step 1: Write the failing test**

Add to the SDK's existing test file for `Assets` (find it beside `assets.ts`; if none exists, create `typescript/packages/sdk/src/assets.test.ts` following the pattern of the nearest existing SDK test):

```ts
test('timelineBucket asks for one period', async () => {
  const http = recordingHttp({ items: [], nextCursor: null, total: 0 })
  await new Assets(http).timelineBucket({ period: '2011-08', limit: 5000 })
  expect(http.calls[0]).toMatchObject({
    method: 'GET',
    path: '/api/v1/assets/timeline/bucket',
    query: { period: '2011-08', limit: 5000 },
  })
})

test('trash accepts a bare id list, as it always has', async () => {
  const http = recordingHttp({ count: 1 })
  await new Assets(http).trash(['6a5f1e2c-90b4-4d1a-8f3e-2b7c9d0a1e45'])
  expect(http.calls[0]?.body).toEqual({ assetIds: ['6a5f1e2c-90b4-4d1a-8f3e-2b7c9d0a1e45'] })
})

test('trash accepts a selection by query', async () => {
  const http = recordingHttp({ count: 12431 })
  await new Assets(http).trash({ query: { favorite: true }, except: [] })
  expect(http.calls[0]?.body).toEqual({ query: { favorite: true }, except: [] })
})
```

Write `recordingHttp` as a local helper implementing `HttpClient` that pushes `{method, path, query, body}` onto `calls` and resolves the given payload. Match whatever stub style the neighbouring SDK tests already use rather than inventing a second one.

- [ ] **Step 2: Run and watch it fail**

Run: `cd ~/src/imogen-timeline/imogen-sdk/typescript && bun test packages/sdk/src/assets.test.ts`
Expected: FAIL — `timelineBucket is not a function`.

- [ ] **Step 3: Implement**

In `typescript/packages/sdk/src/assets.ts`, add the exported page type beside `AssetPage`:

```ts
export type TilePage = { items: TimelineTile[]; nextCursor: string | null; total: number | null }
```

Replace `timeline()` and add its neighbour:

```ts
  timeline(query: Partial<TimelineQuery> = {}): Promise<{ buckets: TimelineBucket[] }> {
    return this.http.request('GET', '/api/v1/assets/timeline', { query })
  }

  /** Every tile in one period, in one round trip, for a grid that lays itself out. */
  timelineBucket(query: TimelineBucketQuery): Promise<TilePage> {
    return this.http.request<TilePage>('GET', '/api/v1/assets/timeline/bucket', { query })
  }
```

Introduce one shared normaliser near the top of the file, because four methods across three classes need it:

```ts
/** The id list is the older, shorter way of saying the same thing. */
export function selectionBody(selection: string[] | AssetSelection): AssetSelection {
  return Array.isArray(selection) ? { assetIds: selection } : selection
}
```

Then `trash` and `restore` become:

```ts
  trash(selection: string[] | AssetSelection): Promise<{ count: number }> {
    return this.http.request('POST', '/api/v1/assets/trash', { body: selectionBody(selection) })
  }

  restore(selection: string[] | AssetSelection): Promise<{ count: number }> {
    return this.http.request('POST', '/api/v1/assets/restore', { body: selectionBody(selection) })
  }
```

Apply the identical treatment to `Albums.addAssets` / `Albums.removeAssets` and `Vault.moveIn` / `Vault.moveOut`, importing `selectionBody` from `./assets.ts`. Export `TilePage` and `selectionBody` from `typescript/packages/sdk/src/index.ts`.

- [ ] **Step 4: Run and watch it pass**

Run: `cd ~/src/imogen-timeline/imogen-sdk/typescript && bun run verify`
Expected: PASS — lint, typecheck, and every test including conformance.

- [ ] **Step 5: Commit**

```bash
cd ~/src/imogen-timeline/imogen-sdk
git add typescript/packages/sdk/src/
git commit -m "$(cat <<'MSG'
TypeScript: timelineBucket, and selections by query

trash, restore, the album membership calls and the vault moves all take
either the id list they always took or a filter with exclusions. The array
form is normalised in one place, so the four call sites cannot drift.

Co-Authored-By: Claude with claude-opus-5[1m]
MSG
)"
```

### Task 3: Rust port

**Files:**
- Modify: `rust/src/models.rs`, `rust/src/assets.rs`, `rust/src/albums.rs`, `rust/src/vault.rs`
- Test: `rust/tests/conformance.rs`

**Interfaces:**
- Consumes: `conformance/endpoints.json` row `assets.timelineBucket`; `conformance/models.json` entry `timelineTile`.
- Produces:
  - `TimelineTile` struct, `serde(rename_all = "camelCase")`, `Option<u32>` for `width`/`height`, `Option<f64>` for `duration`, `Option<String>` for `placeholder_color` and `live_photo_video_id`
  - `TimelineBucket.cover_asset_id: Option<String>`
  - `AssetFilter`, `AssetSelection` structs with `#[serde(skip_serializing_if = "Option::is_none")]`
  - `TimelineBucketQuery { period: String, cursor: Option<String>, limit: Option<u32>, filter: AssetFilter }` with a `to_pairs()` method mirroring the one `AssetQuery` already has
  - `Assets::timeline(&self, query: &TimelineQuery) -> Result<Timeline>`
  - `Assets::timeline_bucket(&self, query: &TimelineBucketQuery) -> Result<TilePage>`
  - `Assets::trash(&self, selection: &AssetSelection) -> Result<AffectedCount>` and `restore` likewise
  - `AssetSelection::ids(&[String]) -> AssetSelection` constructor, so callers keep a one-liner

- [ ] **Step 1: Add the conformance case and watch it fail**

In `rust/tests/conformance.rs`, add `"assets.timelineBucket" => drop(client.assets.timeline_bucket(&Default::default()).await),` to the operation match, following the exact form of the neighbouring `"assets.timeline"` arm.

Run: `cd ~/src/imogen-timeline/imogen-sdk/rust && cargo test`
Expected: FAIL — no method `timeline_bucket`.

- [ ] **Step 2: Implement the models**

In `rust/src/models.rs`, beside the existing `TimelineBucket`, add `cover_asset_id: Option<String>` to it and add `TimelineTile`, `TilePage`, `AssetFilter`, `TimelineQuery`, `TimelineBucketQuery`, and `AssetSelection`. Copy the doc-comment voice of the existing structs — one sentence saying why the type exists, not what its fields are. `AssetFilter` and `TimelineBucketQuery` need `to_pairs()` returning `Vec<(String, String)>`; mirror `AssetQuery::to_pairs` exactly, including how it lowercases booleans.

- [ ] **Step 3: Implement the calls**

In `rust/src/assets.rs`, change `timeline` to take `&TimelineQuery` and pass its pairs as the query string, and add `timeline_bucket` beside it in the same shape. Change `trash` and `restore` to take `&AssetSelection` and serialise it directly rather than building `json!({ "assetIds": ... })`. Apply the same change to the album membership calls in `albums.rs` and the vault moves in `vault.rs`.

- [ ] **Step 4: Run and watch it pass**

Run: `cd ~/src/imogen-timeline/imogen-sdk/rust && cargo test && cargo clippy -- -D warnings`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd ~/src/imogen-timeline/imogen-sdk
git add rust/
git commit -m "$(cat <<'MSG'
Rust: timeline_bucket, and selections by query

Mirrors the TypeScript port. AssetSelection::ids keeps the common case a
one-liner at the call sites that only ever had a list.

Co-Authored-By: Claude with claude-opus-5[1m]
MSG
)"
```

### Task 4: Python port

**Files:**
- Modify: `python/src/imogen_sdk/models.py`, `python/src/imogen_sdk/resources.py`
- Test: `python/tests/test_conformance.py`

**Interfaces:**
- Produces: `TimelineTile`, `TilePage`, `AssetFilter`, `TimelineQuery`, `TimelineBucketQuery`, `AssetSelection` as `Contract` subclasses; `TimelineBucket.cover_asset_id: str | None = None`; `Assets.timeline(query: TimelineQuery | None = None)`, `Assets.timeline_bucket(query: TimelineBucketQuery) -> TilePage`, `Assets.trash(selection: Iterable[str] | AssetSelection) -> int`, `Assets.restore(...)` likewise, and the matching album and vault methods.

- [ ] **Step 1: Add the conformance case and watch it fail**

In `python/tests/test_conformance.py`, add
`"assets.timelineBucket": lambda: client.assets.timeline_bucket(TimelineBucketQuery(period="2011-08")),`
next to the existing `"assets.timeline"` entry.

Run: `cd ~/src/imogen-timeline/imogen-sdk/python && python -m pytest tests/test_conformance.py -v`
Expected: FAIL — `Assets` has no attribute `timeline_bucket`.

- [ ] **Step 2: Implement**

Add the models to `models.py` in the `Contract` style already used, keeping the existing `"""One sentence."""` docstring voice, and add every new name to the `__all__` list at the top of the file. Add the methods to `resources.py` mirroring `timeline` exactly — `Model.model_validate(await self.http.request(...))`. `trash` and `restore` normalise an iterable of ids into `AssetSelection(asset_ids=list(selection))` before dumping with `by_alias=True, exclude_none=True`.

- [ ] **Step 3: Run and watch it pass**

Run: `cd ~/src/imogen-timeline/imogen-sdk/python && python -m pytest -q`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
cd ~/src/imogen-timeline/imogen-sdk
git add python/
git commit -m "$(cat <<'MSG'
Python: timeline_bucket, and selections by query

Mirrors the TypeScript port.

Co-Authored-By: Claude with claude-opus-5[1m]
MSG
)"
```

### Task 5: Swift port

**Files:**
- Modify: the model and asset-resource sources under `swift/`
- Test: the conformance test under `swift/`

**Interfaces:** the same seven types and the same method set as Task 4, in Swift's naming (`timelineBucket(_:)`, `coverAssetId`, `Codable` structs with optionals for every nullable field). Find the existing `TimelineBucket` and `timeline()` first and mirror the file they live in — including whether the port uses `CodingKeys` or a key-decoding strategy.

- [ ] **Step 1:** Add `assets.timelineBucket` to the Swift conformance test beside `assets.timeline`. Run the suite; expected FAIL, no such method.
- [ ] **Step 2:** Add the models and the methods, mirroring the existing `timeline` and `TimelineBucket`.
- [ ] **Step 3:** Run the Swift test suite; expected PASS.
- [ ] **Step 4:** Commit with `git add swift/` and the message `Swift: timelineBucket, and selections by query` plus a one-line body `Mirrors the TypeScript port.` and the `Co-Authored-By` trailer.

### Task 6: Kotlin port

**Files:**
- Modify: the model and asset-resource sources under `kotlin/`
- Test: the conformance test under `kotlin/`

**Interfaces:** the same seven types and the same method set, in Kotlin's naming (`timelineBucket(query)`, `coverAssetId`, `@Serializable` data classes with nullable types and defaults where the contract has them). Mirror the existing `TimelineBucket` and `timeline()`.

- [ ] **Step 1:** Add `assets.timelineBucket` to the Kotlin conformance test beside `assets.timeline`. Run the suite; expected FAIL.
- [ ] **Step 2:** Add the models and methods, mirroring the existing `timeline`.
- [ ] **Step 3:** Run the Kotlin test suite; expected PASS.
- [ ] **Step 4:** Commit with `git add kotlin/` and the message `Kotlin: timelineBucket, and selections by query` plus the one-line body and the trailer.

### Task 7: SDK pull request

- [ ] **Step 1:** Run the full gate: `cd ~/src/imogen-timeline/imogen-sdk/typescript && bun run verify`, then the Rust, Python, Swift, and Kotlin suites. All must pass.
- [ ] **Step 2:** Push and open the PR:

```bash
cd ~/src/imogen-timeline/imogen-sdk
git push -u origin timeline-scrubbing
gh pr create --title "Timeline bucket contract and selections by query" --body "$(cat <<'MSG'
Adds the contract the windowed timeline work needs, across all five ports.

- `AssetFilter` — the filters every listing shares, defined once. `AssetQuery`
  is now composed from it, and `personId` joins the set so a person's
  photographs can be a timeline rather than an arbitrary sample.
- `TimelineTile` — what a grid tile actually draws, about a quarter the bytes
  of an `Asset`.
- `GET /assets/timeline/bucket` — every tile in one period, one round trip.
- `TimelineBucket.coverAssetId` — a picture for a period card, null unless asked for.
- `AssetSelection` — bulk mutations take either an id list or a filter with
  exclusions, so "select all" over a large library is a filter rather than a
  hundred thousand uuids in a request body.

The id form of every bulk call is unchanged, and `GET /assets/timeline` with
no parameters returns exactly what it returned before.

Spec: `imogen-server/docs/superpowers/specs/2026-08-27-timeline-scrubbing-design.md`

🤖 Generated with [Claude Code](https://claude.com/claude-code)

https://claude.ai/code/session_015MF3M6T94djHJmr5neeZkv
MSG
)"
```

---

# Phase 2 — The server

Repository: `imogen-server`. Tasks 8 and 9 touch mostly disjoint files and may run in parallel; Task 10 follows both.

### Task 8: Timeline aggregate and bucket endpoint

**Files:**
- Modify: `packages/server/src/media/assets.ts`
- Modify: `packages/server/src/api/assets.ts`
- Test: `packages/server/src/media/assets.test.ts`

**Interfaces:**
- Consumes: `AssetFilter`, `TimelineBucket`, `TimelineBucketQuery`, `TimelineQuery`, `TimelineTile`, `pageOf` from `@imogen/shared`.
- Produces:
  - `AssetService.timeline(ownerId: string, query: TimelineQuery): Promise<TimelineBucket[]>`
  - `AssetService.bucket(ownerId: string, query: TimelineBucketQuery): Promise<{ items: TimelineTile[]; nextCursor: string | null; total: number | null }>`
  - `AssetService.buildFilters(ownerId: string, filter: AssetFilter & { trashed?: boolean })` — now takes a filter rather than a full query, and understands `personId`
  - `toTile(row: typeof assets.$inferSelect): TimelineTile`

- [ ] **Step 1: Write the failing tests**

Append to the existing `describe('timeline buckets', ...)` in `packages/server/src/media/assets.test.ts`:

```ts
test('a bucket carries every tile in its month, newest first', async () => {
  await seed(ownerId, [
    { capturedAt: '2011-08-14T09:00:00Z' },
    { capturedAt: '2011-08-14T18:00:00Z' },
    { capturedAt: '2011-09-02T09:00:00Z' },
  ])
  const page = await service.bucket(ownerId, { period: '2011-08', limit: 5000 })
  expect(page.items).toHaveLength(2)
  expect(page.items[0]!.capturedAt).toBe('2011-08-14T18:00:00.000Z')
  expect(page.total).toBe(2)
  expect(page.nextCursor).toBeNull()
})

test('a bucket accepts a single day as well as a month', async () => {
  await seed(ownerId, [
    { capturedAt: '2011-08-14T09:00:00Z' },
    { capturedAt: '2011-08-15T09:00:00Z' },
  ])
  const page = await service.bucket(ownerId, { period: '2011-08-14', limit: 5000 })
  expect(page.items).toHaveLength(1)
})

test('a bucket pages when a period holds more than the limit', async () => {
  await seed(ownerId, Array.from({ length: 5 }, (_, i) => ({
    capturedAt: `2011-08-1${i}T09:00:00Z`,
  })))
  const first = await service.bucket(ownerId, { period: '2011-08', limit: 2 })
  expect(first.items).toHaveLength(2)
  expect(first.nextCursor).not.toBeNull()
  const second = await service.bucket(ownerId, { period: '2011-08', limit: 2, cursor: first.nextCursor! })
  expect(second.items).toHaveLength(2)
  expect(second.items[0]!.id).not.toBe(first.items[0]!.id)
})

test('period intersects takenAfter rather than widening it', async () => {
  await seed(ownerId, [
    { capturedAt: '2011-08-05T09:00:00Z' },
    { capturedAt: '2011-08-25T09:00:00Z' },
  ])
  const page = await service.bucket(ownerId, {
    period: '2011-08',
    limit: 5000,
    takenAfter: '2011-08-20T00:00:00.000Z',
  })
  expect(page.items).toHaveLength(1)
})

test('a bucket keeps the vault out, like every other listing', async () => {
  await seed(ownerId, [{ capturedAt: '2011-08-14T09:00:00Z', vaultedAt: new Date() }])
  const page = await service.bucket(ownerId, { period: '2011-08', limit: 5000 })
  expect(page.items).toHaveLength(0)
})

test('buckets narrow to an album when asked', async () => {
  const albumId = await seedAlbum(ownerId, [{ capturedAt: '2011-08-14T09:00:00Z' }])
  await seed(ownerId, [{ capturedAt: '2011-08-15T09:00:00Z' }])
  const buckets = await service.timeline(ownerId, { albumId })
  expect(buckets).toEqual([{ date: '2011-08-14', count: 1, coverAssetId: null }])
})

test('covers name the newest ready asset, and nothing when none is ready', async () => {
  await seed(ownerId, [
    { capturedAt: '2011-08-14T09:00:00Z', status: 'ready' },
    { capturedAt: '2011-08-14T18:00:00Z', status: 'processing' },
  ])
  const [bucket] = await service.timeline(ownerId, { covers: true })
  expect(bucket!.coverAssetId).not.toBeNull()

  await service.trash(ownerId, [bucket!.coverAssetId!])
  const [afterwards] = await service.timeline(ownerId, { covers: true })
  expect(afterwards!.coverAssetId).toBeNull()
})

test('a timeline with no filters answers exactly as it did before', async () => {
  await seed(ownerId, [{ capturedAt: '2011-08-14T09:00:00Z' }])
  expect(await service.timeline(ownerId, {})).toEqual([
    { date: '2011-08-14', count: 1, coverAssetId: null },
  ])
})
```

Use whatever seeding helper the file already has; if it seeds through `service.create` or a fixture builder, follow that rather than inserting rows directly. Add `seedAlbum` beside it if no equivalent exists.

- [ ] **Step 2: Run and watch them fail**

Run: `cd ~/src/imogen-timeline/imogen-server && bun test packages/server/src/media/assets.test.ts`
Expected: FAIL — `service.bucket is not a function`, and `timeline` rejects a second argument.

- [ ] **Step 3: Teach `buildFilters` the filter type and `personId`**

Change its signature to `private buildFilters(ownerId: string, filter: AssetFilter): SQL[]` — the body already only reads filter fields, so the change is the type plus one new condition, placed beside the `albumId` block it mirrors:

```ts
    if (filter.personId) {
      conditions.push(
        sql`exists (select 1 from ${faces} where ${faces.assetId} = ${assets.id} and ${faces.personId} = ${filter.personId})`,
      )
    }
```

Import `faces` from `../db/schema.ts`. `list()` continues to call it with the full `AssetQuery`, which structurally satisfies `AssetFilter`.

- [ ] **Step 4: Implement `timeline` and `bucket`**

Replace `timeline` and add `bucket` and `toTile` in `packages/server/src/media/assets.ts`:

```ts
  async timeline(ownerId: string, query: TimelineQuery = {}): Promise<TimelineBucket[]> {
    const conditions = this.buildFilters(ownerId, query)
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
  async bucket(ownerId: string, query: TimelineBucketQuery) {
    const { start, end } = periodBounds(query.period)
    const conditions = [
      ...this.buildFilters(ownerId, query),
      gte(assets.capturedAt, start),
      lt(assets.capturedAt, end),
    ]

    const after = query.cursor ? decodeCursor(query.cursor) : null
    if (after) {
      conditions.push(
        sql`(${assets.capturedAt}, ${assets.id}) < (${new Date(after.value)}, ${after.id})`,
      )
    }

    const rows = await this.db
      .select()
      .from(assets)
      .where(and(...conditions))
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
      .where(and(...this.buildFilters(ownerId, query), gte(assets.capturedAt, start), lt(assets.capturedAt, end)))

    return {
      items: page.map(toTile),
      nextCursor:
        hasMore && last
          ? encodeCursor({ value: last.capturedAt.toISOString(), id: last.id })
          : null,
      total: Number(counted?.total ?? 0),
    }
  }
```

Add the bounds helper beside the other module-level functions in the same file:

```ts
/** `2011-08` is a month; `2011-08-14` is a day. Both are half-open, both in UTC. */
function periodBounds(period: string): { start: Date; end: Date } {
  const [year, month, day] = period.split('-').map(Number)
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
```

And the projection, beside the existing `toAsset`:

```ts
function toTile(row: typeof assets.$inferSelect): TimelineTile {
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
```

Import `gte`, `lt`, and `desc` from `drizzle-orm` if the file does not already have them.

- [ ] **Step 5: Run and watch them pass**

Run: `cd ~/src/imogen-timeline/imogen-server && bun test packages/server/src/media/assets.test.ts`
Expected: PASS, including the unchanged-behaviour case.

- [ ] **Step 6: Wire the routes**

In `packages/server/src/api/assets.ts`, give the existing `/timeline` route `request: { query: TimelineQuery }` and pass `c.req.valid('query')` into the service. Add the bucket route directly beneath it, following the existing `createRoute` shape exactly:

```ts
  app.openapi(
    createRoute({
      method: 'get',
      path: '/timeline/bucket',
      tags: ['Assets'],
      summary: 'Every tile in one period, for a grid that lays itself out',
      description:
        'A lean projection — id, capture time, dimensions, and what a tile draws — for ' +
        'every asset in a month or a day. Around a quarter the bytes of the same assets ' +
        'from `GET /assets`.',
      security: security(),
      middleware: [requireScope('library:read')] as const,
      request: { query: TimelineBucketQuery },
      responses: { ...ok(pageOf(TimelineTile), 'A page of tiles'), ...ERROR_RESPONSES },
    }),
    async (c) => {
      const services = c.get('services')
      const page = await services.assets.bucket(c.get('principal').user.id, c.req.valid('query'))
      return c.json(page, 200)
    },
  )
```

**Route ordering matters.** `/timeline/bucket` must be registered before any `/:id`-style route in the same router, or the id route swallows it. Check where `/timeline` and `/stats` sit relative to `/:id` today and place the new one with them.

- [ ] **Step 7: Verify and commit**

Run: `cd ~/src/imogen-timeline/imogen-server && bun run verify`
Expected: PASS.

```bash
git add packages/server/src/media/assets.ts packages/server/src/api/assets.ts packages/server/src/media/assets.test.ts
git commit -m "$(cat <<'MSG'
Serve the timeline's shape, and one period at a time

The day aggregate has existed since the beginning, described in its own route
as being there "so a client can size its scrollbar before loading anything",
and nothing has ever called it. It now takes the same filters as every other
listing, so it can describe an album or a person as readily as the library,
and can name a picture for each period.

Beside it, a bucket endpoint returns every tile in a month in one answer.
A grid draws ten fields; an Asset carries twenty-five.

Co-Authored-By: Claude with claude-opus-5[1m]
MSG
)"
```

### Task 9: Selections by query

**Files:**
- Modify: `packages/server/src/media/assets.ts`
- Modify: `packages/server/src/api/assets.ts`, `packages/server/src/api/albums.ts`, `packages/server/src/api/vault.ts`
- Modify: `packages/server/src/faces/faces.ts`
- Test: `packages/server/src/media/assets.test.ts`

**Interfaces:**
- Consumes: `AssetSelection` from `@imogen/shared`; `buildFilters` from Task 8.
- Produces:
  - `AssetService.trashSelection(ownerId: string, selection: AssetSelection): Promise<number>`
  - `AssetService.restoreSelection(ownerId: string, selection: AssetSelection): Promise<number>`
  - `AssetService.selectionConditions(ownerId: string, selection: AssetSelection): SQL[]`
  - `FaceService.forgetAssets(assetIds: string[], ownerId: string): Promise<void>`
  - The existing `trash(ownerId, assetIds)` and `restore(ownerId, assetIds)` are untouched.

- [ ] **Step 1: Write the failing tests**

```ts
describe('selections by query', () => {
  test('trashes everything a filter matches', async () => {
    await seed(ownerId, [
      { capturedAt: '2011-08-14T09:00:00Z', favorite: true },
      { capturedAt: '2011-08-15T09:00:00Z', favorite: true },
      { capturedAt: '2011-08-16T09:00:00Z', favorite: false },
    ])
    expect(await service.trashSelection(ownerId, { query: { favorite: true } })).toBe(2)
    expect((await service.list(ownerId, { limit: 100 })).items).toHaveLength(1)
  })

  test('honours the exclusion set', async () => {
    await seed(ownerId, [
      { capturedAt: '2011-08-14T09:00:00Z', favorite: true },
      { capturedAt: '2011-08-15T09:00:00Z', favorite: true },
    ])
    const [keep] = (await service.list(ownerId, { limit: 100 })).items
    expect(await service.trashSelection(ownerId, { query: { favorite: true }, except: [keep!.id] })).toBe(1)
    expect((await service.list(ownerId, { limit: 100 })).items[0]!.id).toBe(keep!.id)
  })

  test('never reaches another owner', async () => {
    const stranger = await seedOwner()
    await seed(stranger, [{ capturedAt: '2011-08-14T09:00:00Z', favorite: true }])
    await seed(ownerId, [{ capturedAt: '2011-08-14T09:00:00Z', favorite: true }])
    expect(await service.trashSelection(ownerId, { query: { favorite: true } })).toBe(1)
  })

  test('never reaches the vault', async () => {
    await seed(ownerId, [{ capturedAt: '2011-08-14T09:00:00Z', favorite: true, vaultedAt: new Date() }])
    expect(await service.trashSelection(ownerId, { query: { favorite: true } })).toBe(0)
  })

  test('the id form still works exactly as it did', async () => {
    await seed(ownerId, [{ capturedAt: '2011-08-14T09:00:00Z' }])
    const [only] = (await service.list(ownerId, { limit: 100 })).items
    expect(await service.trashSelection(ownerId, { assetIds: [only!.id] })).toBe(1)
  })

  test('restores by query, from the trash', async () => {
    await seed(ownerId, [{ capturedAt: '2011-08-14T09:00:00Z', favorite: true }])
    await service.trashSelection(ownerId, { query: { favorite: true } })
    expect(await service.restoreSelection(ownerId, { query: { favorite: true, trashed: true } })).toBe(1)
  })
})
```

- [ ] **Step 2: Run and watch them fail**

Run: `cd ~/src/imogen-timeline/imogen-server && bun test packages/server/src/media/assets.test.ts`
Expected: FAIL — `service.trashSelection is not a function`.

- [ ] **Step 3: Implement**

In `packages/server/src/media/assets.ts`:

```ts
  /**
   * The rows a selection means, as conditions rather than as ids. The whole point is that
   * a hundred thousand photographs never become a hundred thousand uuids — not in a
   * request body, not in a Set, and not in an `in` list.
   */
  private selectionConditions(ownerId: string, selection: AssetSelection): SQL[] {
    if (selection.assetIds) {
      return [eq(assets.ownerId, ownerId), isNull(assets.vaultedAt), inArray(assets.id, selection.assetIds)]
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

  async restoreSelection(ownerId: string, selection: AssetSelection): Promise<number> {
    const rows = await this.db
      .update(assets)
      .set({ deletedAt: null, updatedAt: new Date() })
      .where(and(...this.selectionConditions(ownerId, selection)))
      .returning({ id: assets.id })
    return rows.length
  }
```

Import `notInArray` from `drizzle-orm`.

Note the vault guard: `buildFilters` already pushes `isNull(assets.vaultedAt)` as its second condition, and the id branch above repeats it explicitly. Neither branch can reach a vaulted photograph, which is the invariant the vault depends on.

- [ ] **Step 4: Run and watch them pass**

Run: `cd ~/src/imogen-timeline/imogen-server && bun test packages/server/src/media/assets.test.ts`
Expected: PASS.

- [ ] **Step 5: Add a set-based forget to the face service**

In `packages/server/src/faces/faces.ts`, beside `forgetAsset`, add:

```ts
  /** The same as forgetting one, for a selection that may run to tens of thousands. */
  async forgetAssets(assetIds: string[], ownerId: string): Promise<void> {
    if (assetIds.length === 0) return
    await this.db
      .delete(faces)
      .where(and(eq(faces.ownerId, ownerId), inArray(faces.assetId, assetIds)))
    await this.refreshCounts(ownerId)
  }
```

- [ ] **Step 6: Wire the routes**

In `packages/server/src/api/assets.ts`, change the `/trash` and `/restore` routes' request schema from `IdsBody` to `AssetSelection` and call `trashSelection` / `restoreSelection`. Leave `IdsBody` in the file: other routes still use it.

In `packages/server/src/api/albums.ts`, do the same for the two membership routes, resolving a query selection to ids inside the album service before inserting or deleting rows — album membership is a join table, so it genuinely needs the ids; resolve them with a `select id` over the same conditions rather than round-tripping through the client.

In `packages/server/src/api/vault.ts`, change the two move routes to `AssetSelection`, resolve to ids the same way, and replace the `for (const assetId of assetIds) await services.faces.forgetAsset(...)` loop with a single `forgetAssets(assetIds, ownerId)` call.

- [ ] **Step 7: Verify and commit**

Run: `cd ~/src/imogen-timeline/imogen-server && bun run verify`
Expected: PASS.

```bash
git add packages/server/src/
git commit -m "$(cat <<'MSG'
Take a selection as a filter, not as a hundred thousand ids

Selecting a whole library and moving it to the trash used to mean sending
every id, which the thousand-id cap made impossible and which would have been
a poor idea at any cap. A selection is now either the id list it always was,
or the filter the user was looking at minus what they unticked, and the
server turns the second form into one statement.

The vault's move loop called forgetAsset once per photograph; by query that
would have been tens of thousands of sequential calls, so faces learned to
forget a set.

Co-Authored-By: Claude with claude-opus-5[1m]
MSG
)"
```

### Task 10: The three unbounded payloads

**Files:**
- Modify: `packages/server/src/media/albums.ts`
- Modify: `packages/server/src/faces/faces.ts`
- Modify: `packages/server/src/api/share.ts`
- Test: `packages/server/src/media/albums.test.ts`, `packages/server/src/faces/faces.test.ts`, and the share tests

**Interfaces:**
- Consumes: `bucket()` and the `personId` filter from Task 8.
- Produces: `COVER_SAMPLE = 60` exported from `packages/server/src/media/albums.ts`; `AlbumService.getWithAssets` returns at most that many, ordered; `FaceService.photosOf(ownerId, personId, limit = COVER_SAMPLE)` ordered `capturedAt desc, id desc`; a `GET /share/:slug/timeline` and `GET /share/:slug/timeline/bucket` pair.

- [ ] **Step 1: Write the failing tests**

```ts
test('an album carries a cover sample, not every photograph it holds', async () => {
  const albumId = await seedAlbumWith(ownerId, 200)
  const album = await service.getWithAssets(ownerId, albumId)
  expect(album.assets).toHaveLength(60)
  expect(album.assets[0]!.capturedAt >= album.assets[1]!.capturedAt).toBe(true)
})

test("a person's sample is the most recent, not an arbitrary slice of uuid order", async () => {
  const personId = await seedPersonWith(ownerId, 200)
  const photos = await faces.photosOf(ownerId, personId)
  expect(photos).toHaveLength(60)
  for (let i = 1; i < photos.length; i++) {
    expect(photos[i - 1]!.capturedAt >= photos[i]!.capturedAt).toBe(true)
  }
})

test('a shared album checks membership in the database, not by scanning an array', async () => {
  const { slug, insideId, outsideId } = await seedShareWithOutsider(ownerId)
  expect((await fetchVariant(slug, insideId, 'thumbnail')).status).toBe(200)
  expect((await fetchVariant(slug, outsideId, 'thumbnail')).status).toBe(404)
})
```

- [ ] **Step 2: Run and watch them fail**

Run: `cd ~/src/imogen-timeline/imogen-server && bun test packages/server/src/media/albums.test.ts packages/server/src/faces/faces.test.ts`
Expected: FAIL — the album returns 200 assets and the person's sample is unordered.

- [ ] **Step 3: Cap and order the album sample**

In `packages/server/src/media/albums.ts`, export the cap and apply it, replacing the comment about ordering with one that also says why the list is short:

```ts
/**
 * How many photographs travel with an album or a person. Enough to draw a cover and a
 * glance; not a substitute for the timeline, which is where the grid gets its contents
 * now. An album of thirty thousand used to arrive here in full, as full Assets.
 */
export const COVER_SAMPLE = 60
```

Add `.limit(COVER_SAMPLE)` after the existing `.orderBy(desc(assets.capturedAt), desc(assets.id))`.

- [ ] **Step 4: Order the person's sample**

In `packages/server/src/faces/faces.ts`, `photosOf` becomes:

```ts
  /**
   * A sample of the photographs a person appears in, newest first. This used to be
   * `selectDistinctOn` with no `orderBy` at all, which meant an arbitrary five hundred
   * in uuid order — not the five hundred most recent, and grouped by day it read as
   * noise. The grid now comes from the timeline under a `personId` filter; this is the
   * cover sample.
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
```

Import `COVER_SAMPLE` from `../media/albums.ts` — one cap, named once, rather than the same number written in two files that would then drift.

Postgres requires the `distinct on` expressions to lead the `order by`; `(capturedAt, id)` is unique enough to dedupe the join and is the order we want anyway.

- [ ] **Step 5: Replace the share guard and add its timeline**

In `packages/server/src/api/share.ts`, replace

```ts
    if (!share.album.assets.some((a) => a.id === assetId)) {
```

with a database check — the array is now a sixty-item sample and scanning it would reject valid photographs, quite apart from having been O(n) per thumbnail before:

```ts
    const [member] = await services.db
      .select({ id: albumAssets.assetId })
      .from(albumAssets)
      .where(and(eq(albumAssets.albumId, share.album.id), eq(albumAssets.assetId, assetId)))
      .limit(1)
    if (!member) {
```

Import `albumAssets` and `and` where the file imports its neighbours. Then add `GET /:slug/timeline` and `GET /:slug/timeline/bucket` beside the existing routes, each opening the share the same way and delegating to `services.assets.timeline` / `services.assets.bucket` with `{ albumId: share.album.id }` and the album owner's id — never the visitor's.

- [ ] **Step 6: Run and watch them pass, then verify**

Run: `cd ~/src/imogen-timeline/imogen-server && bun run verify`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/server/src/
git commit -m "$(cat <<'MSG'
Stop three endpoints from answering with the whole library

An album returned every asset it held, as full Assets — thirty thousand
photographs is a twenty-four megabyte reply. A person returned five hundred
chosen by uuid order with no ORDER BY at all, so it was not the five hundred
most recent and, grouped by day, read as noise. And a shared album checked
membership by scanning that same unbounded array once per thumbnail request.

All three now hand out a cover sample and let the timeline serve the grid.
The share guard asks the database.

Co-Authored-By: Claude with claude-opus-5[1m]
MSG
)"
```

---

# Phase 3 — The web client

Repository: `imogen-server`. Task 11 runs alone and first; Tasks 12, 13, and 14 follow it in parallel.

### Task 11: The geometry engine

**Files:**
- Create: `packages/web/src/lib/timelineLayout.ts`
- Test: `packages/web/src/lib/timelineLayout.test.ts`

**Interfaces:**
- Consumes: `justify`, `aspectOf` from `./justify.ts`; `TimelineBucket`, `TimelineTile` from `@imogen/shared`.
- Produces — Tasks 12, 13, and 14 import exactly these:

```ts
export type DaySegment = {
  date: string          // YYYY-MM-DD, UTC
  count: number
  top: number           // absolute pixels from the top of the whole timeline
  height: number
  measured: boolean     // false while the height is an estimate
}

export type SegmentTable = {
  segments: DaySegment[]          // newest first, matching the bucket order
  byDate: Map<string, DaySegment>
  totalHeight: number
}

export type LayoutOptions = {
  width: number
  targetHeight: number
  gap: number
  sectionGap: number
  headerHeight: number
}

export function buildSegments(
  buckets: TimelineBucket[],
  loaded: Map<string, TimelineTile[]>,   // keyed by YYYY-MM-DD
  options: LayoutOptions,
  measured: Map<string, number>,          // date -> height, never evicted
): SegmentTable

export function estimateDayHeight(count: number, options: LayoutOptions): number
export function segmentsInRange(table: SegmentTable, top: number, bottom: number): DaySegment[]
export function scrollDelta(previous: SegmentTable, next: SegmentTable, scrollTop: number): number
export function dateAtOffset(table: SegmentTable, offset: number): string | null
export function offsetForDate(table: SegmentTable, date: string): number
export function periodOf(date: string): string   // '2011-08-14' -> '2011-08'
export function groupTilesByDay(tiles: TimelineTile[]): Map<string, TimelineTile[]>
```

- [ ] **Step 1: Write the failing test**

Create `packages/web/src/lib/timelineLayout.test.ts`:

```ts
import { describe, expect, test } from 'bun:test'
import type { TimelineBucket, TimelineTile } from '@imogen/shared'
import {
  buildSegments,
  dateAtOffset,
  estimateDayHeight,
  groupTilesByDay,
  offsetForDate,
  periodOf,
  scrollDelta,
  segmentsInRange,
  type LayoutOptions,
} from './timelineLayout.ts'

const OPTIONS: LayoutOptions = {
  width: 1200,
  targetHeight: 208,
  gap: 4,
  sectionGap: 44,
  headerHeight: 40,
}

const bucket = (date: string, count: number): TimelineBucket => ({ date, count, coverAssetId: null })

const tile = (id: string, capturedAt: string, width = 4032, height = 3024): TimelineTile => ({
  id,
  capturedAt,
  width,
  height,
  type: 'image',
  status: 'ready',
  favorite: false,
  duration: null,
  placeholderColor: '#3b5f7a',
  livePhotoVideoId: null,
})

describe('buildSegments', () => {
  test('lays every bucket out head to tail with no gaps or overlaps', () => {
    const table = buildSegments(
      [bucket('2011-08-15', 10), bucket('2011-08-14', 3), bucket('2011-08-13', 40)],
      new Map(),
      OPTIONS,
      new Map(),
    )
    expect(table.segments[0]!.top).toBe(0)
    for (let i = 1; i < table.segments.length; i++) {
      const previous = table.segments[i - 1]!
      expect(table.segments[i]!.top).toBe(previous.top + previous.height)
    }
    const last = table.segments.at(-1)!
    expect(table.totalHeight).toBe(last.top + last.height)
  })

  test('a day with more photographs is taller than a day with fewer', () => {
    const table = buildSegments([bucket('2011-08-15', 100), bucket('2011-08-14', 2)], new Map(), OPTIONS, new Map())
    expect(table.segments[0]!.height).toBeGreaterThan(table.segments[1]!.height)
  })

  test('an unloaded day is an estimate; a loaded one is measured', () => {
    const loaded = new Map([['2011-08-14', [tile('a', '2011-08-14T09:00:00.000Z')]]])
    const table = buildSegments([bucket('2011-08-15', 10), bucket('2011-08-14', 1)], loaded, OPTIONS, new Map())
    expect(table.byDate.get('2011-08-15')!.measured).toBe(false)
    expect(table.byDate.get('2011-08-14')!.measured).toBe(true)
  })

  test('a measured height survives its tiles being evicted', () => {
    const measured = new Map([['2011-08-14', 517]])
    const table = buildSegments([bucket('2011-08-14', 12)], new Map(), OPTIONS, measured)
    expect(table.byDate.get('2011-08-14')!.height).toBe(517)
    expect(table.byDate.get('2011-08-14')!.measured).toBe(true)
  })

  test('an empty library has no height and no segments', () => {
    const table = buildSegments([], new Map(), OPTIONS, new Map())
    expect(table.segments).toHaveLength(0)
    expect(table.totalHeight).toBe(0)
  })

  test('a day of forty thousand photographs produces a finite, ordered height', () => {
    const table = buildSegments([bucket('2011-08-14', 40_000)], new Map(), OPTIONS, new Map())
    expect(Number.isFinite(table.totalHeight)).toBe(true)
    expect(table.totalHeight).toBeGreaterThan(40_000)
  })

  test('a zero width yields no layout rather than dividing by it', () => {
    const table = buildSegments([bucket('2011-08-14', 10)], new Map(), { ...OPTIONS, width: 0 }, new Map())
    expect(table.totalHeight).toBe(0)
  })
})

describe('estimateDayHeight', () => {
  test('includes the header and at least one row for a single photograph', () => {
    expect(estimateDayHeight(1, OPTIONS)).toBeGreaterThan(OPTIONS.headerHeight + OPTIONS.targetHeight)
  })
})

describe('segmentsInRange', () => {
  test('returns only what the window touches, plus nothing else', () => {
    const table = buildSegments(
      Array.from({ length: 50 }, (_, i) => bucket(`2011-08-${String(50 - i).padStart(2, '0')}`, 10)),
      new Map(),
      OPTIONS,
      new Map(),
    )
    const visible = segmentsInRange(table, 1000, 2000)
    expect(visible.length).toBeGreaterThan(0)
    expect(visible.length).toBeLessThan(table.segments.length)
    for (const segment of visible) {
      expect(segment.top).toBeLessThan(2000)
      expect(segment.top + segment.height).toBeGreaterThan(1000)
    }
  })

  test('a window past the end returns nothing rather than throwing', () => {
    const table = buildSegments([bucket('2011-08-14', 3)], new Map(), OPTIONS, new Map())
    expect(segmentsInRange(table, 1_000_000, 1_001_000)).toHaveLength(0)
  })
})

describe('scrollDelta', () => {
  test('is zero when what changed is below the viewport', () => {
    const buckets = [bucket('2011-08-15', 10), bucket('2011-08-14', 10)]
    const before = buildSegments(buckets, new Map(), OPTIONS, new Map())
    const after = buildSegments(buckets, new Map(), OPTIONS, new Map([['2011-08-14', 900]]))
    expect(scrollDelta(before, after, 0)).toBe(0)
  })

  test('is the accumulated change when it happened above the viewport', () => {
    const buckets = [bucket('2011-08-15', 10), bucket('2011-08-14', 10)]
    const before = buildSegments(buckets, new Map(), OPTIONS, new Map())
    const grew = 900 - before.byDate.get('2011-08-15')!.height
    const after = buildSegments(buckets, new Map(), OPTIONS, new Map([['2011-08-15', 900]]))
    expect(scrollDelta(before, after, 5000)).toBe(grew)
  })

  test('a bucket appearing above the viewport during an import counts too', () => {
    const before = buildSegments([bucket('2011-08-14', 10)], new Map(), OPTIONS, new Map())
    const after = buildSegments([bucket('2011-08-15', 10), bucket('2011-08-14', 10)], new Map(), OPTIONS, new Map())
    expect(scrollDelta(before, after, 5000)).toBe(after.byDate.get('2011-08-15')!.height)
  })
})

describe('dateAtOffset and offsetForDate', () => {
  test('round-trip: the offset of a date lands inside that date', () => {
    const table = buildSegments(
      [bucket('2011-08-15', 10), bucket('2011-08-14', 10), bucket('2011-08-13', 10)],
      new Map(),
      OPTIONS,
      new Map(),
    )
    expect(dateAtOffset(table, offsetForDate(table, '2011-08-14'))).toBe('2011-08-14')
  })

  test('an offset past the end reports the oldest day rather than null', () => {
    const table = buildSegments([bucket('2011-08-14', 3)], new Map(), OPTIONS, new Map())
    expect(dateAtOffset(table, 1_000_000)).toBe('2011-08-14')
  })

  test('an unknown date reports the start of the nearest day that exists', () => {
    const table = buildSegments([bucket('2011-08-15', 3), bucket('2011-08-10', 3)], new Map(), OPTIONS, new Map())
    expect(offsetForDate(table, '2011-08-12')).toBe(table.byDate.get('2011-08-10')!.top)
  })

  test('an empty table has no date anywhere', () => {
    expect(dateAtOffset(buildSegments([], new Map(), OPTIONS, new Map()), 0)).toBeNull()
  })
})

describe('periodOf and groupTilesByDay', () => {
  test('a date belongs to its month', () => {
    expect(periodOf('2011-08-14')).toBe('2011-08')
  })

  test('tiles split by UTC day, matching how the server bucketed them', () => {
    const grouped = groupTilesByDay([
      tile('a', '2011-08-14T23:30:00.000Z'),
      tile('b', '2011-08-15T00:30:00.000Z'),
    ])
    expect([...grouped.keys()]).toEqual(['2011-08-14', '2011-08-15'])
  })
})
```

- [ ] **Step 2: Run and watch it fail**

Run: `cd ~/src/imogen-timeline/imogen-server && bun test packages/web/src/lib/timelineLayout.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `packages/web/src/lib/timelineLayout.ts`. The module is pure — no React, no DOM — which is what makes every case above testable. Key decisions to honour:

- The average aspect used for estimation is `1.4`, close to the mix of 3:2 and 4:3 a camera roll actually holds. Name it as a constant with that reasoning in a comment.
- `estimateDayHeight` is `headerHeight + rows * (targetHeight + gap) + sectionGap`, where `rows = max(1, ceil(count / perRow))` and `perRow = max(1, floor(width / (targetHeight * AVERAGE_ASPECT)))`.
- A measured height comes from `justify()` over the day's tiles: `headerHeight + (last.top + last.height) + sectionGap`.
- `measured` takes precedence over `loaded`: a height learned once is never re-derived, so the timeline settles rather than re-jittering.
- `dateAtOffset` and `offsetForDate` binary-search `segments`, which is sorted by `top` ascending. With seven thousand segments a linear scan on every drag frame is visible.
- `scrollDelta` walks both tables' segments in order, accumulating `next.height - previous.height` for every date whose `top` in the *previous* table was below `scrollTop`, plus the full height of any date present in `next` and absent from `previous` under the same test. Return the accumulated total.
- Guard `width <= 0` at the top and return an empty table.

- [ ] **Step 4: Run and watch it pass**

Run: `cd ~/src/imogen-timeline/imogen-server && bun test packages/web/src/lib/timelineLayout.test.ts`
Expected: PASS, all cases.

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/lib/timelineLayout.ts packages/web/src/lib/timelineLayout.test.ts
git commit -m "$(cat <<'MSG'
Work out where every day sits before loading any of them

Day counts plus an average aspect give a height for a day nobody has fetched,
which is enough to place every other day and to know how tall the whole thing
is. A day that has been fetched is measured exactly, through the same justify
that draws it, and a height learned once is kept for good — so the timeline
settles as it is explored instead of shifting under the reader every time
they come back.

Pure, so all of that is testable without a browser.

Co-Authored-By: Claude with claude-opus-5[1m]
MSG
)"
```

### Task 12: Windowed rendering

**Files:**
- Create: `packages/web/src/hooks/useTimeline.ts`
- Modify: `packages/web/src/components/PhotoGrid.tsx`
- Modify: `packages/web/src/routes/Timeline.tsx`
- Test: `packages/web/src/hooks/useTimeline.test.ts`

**Interfaces:**
- Consumes: everything Task 11 produces; `imogen.assets.timeline` and `imogen.assets.timelineBucket` from Task 2.
- Produces:

```ts
export type TimelineWindow = {
  table: SegmentTable
  tiles: Map<string, TimelineTile[]>      // by day
  isPending: boolean
  totalCount: number
  requestPeriods: (periods: string[]) => void
  suspendFetching: (suspended: boolean) => void
}
export function useTimeline(filter: Partial<AssetFilter>, options: LayoutOptions): TimelineWindow
```

`PhotoGrid` gains props `table: SegmentTable`, `tiles: Map<string, TimelineTile[]>`, `onVisibleRangeChange: (top: number, bottom: number) => void`, and drops `onReachEnd` and `loadingMore`.

- [ ] **Step 1: Write the failing test**

Create `packages/web/src/hooks/useTimeline.test.ts` testing the parts that are not React: extract the eviction and request policy into exported pure helpers in `useTimeline.ts` and test those directly, rather than reaching for a renderer the repository does not currently use.

```ts
import { describe, expect, test } from 'bun:test'
import { evictPeriods, periodsToFetch, MAX_LOADED_PERIODS } from './useTimeline.ts'

describe('periodsToFetch', () => {
  test('asks for the visible period and one either side', () => {
    expect(periodsToFetch(['2011-08'], ['2011-09', '2011-08', '2011-07', '2011-06'])).toEqual([
      '2011-09',
      '2011-08',
      '2011-07',
    ])
  })

  test('does not fall off the ends of the library', () => {
    expect(periodsToFetch(['2011-09'], ['2011-09', '2011-08'])).toEqual(['2011-09', '2011-08'])
  })

  test('a drag spanning years still asks only for what it touches', () => {
    const all = ['2011-09', '2011-08', '2011-07']
    expect(periodsToFetch([], all)).toEqual([])
  })
})

describe('evictPeriods', () => {
  test('keeps the most recently used and drops the rest', () => {
    const used = Array.from({ length: MAX_LOADED_PERIODS + 3 }, (_, i) => `2011-${String(i + 1).padStart(2, '0')}`)
    const kept = evictPeriods(used, used.slice(-2))
    expect(kept).toHaveLength(MAX_LOADED_PERIODS)
    expect(kept).toContain(used.at(-1))
    expect(kept).toContain(used.at(-2))
  })

  test('never evicts a period that is currently on screen', () => {
    const used = Array.from({ length: MAX_LOADED_PERIODS + 3 }, (_, i) => `2011-${String(i + 1).padStart(2, '0')}`)
    expect(evictPeriods(used, [used[0]!])).toContain(used[0])
  })
})
```

- [ ] **Step 2: Run and watch it fail**

Run: `cd ~/src/imogen-timeline/imogen-server && bun test packages/web/src/hooks/useTimeline.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the hook**

`useTimeline` owns:
- A `useQuery` for the spine: `['timeline', filter]` → `imogen.assets.timeline(filter)`, `staleTime: 30_000`.
- A `measured` ref: `useRef(new Map<string, number>())`, never cleared except when `filter` changes.
- A `tiles` state: `Map<string, TimelineTile[]>` by day, plus a `loadedPeriods` array in most-recently-used order.
- A `useQueries` (or a small effect-driven fetch loop) over `periodsToFetch(...)`, skipped entirely while `suspendFetching(true)` is in force.
- The segment table, from `buildSegments(buckets, tiles, options, measured.current)`, in a `useMemo` keyed on all four.
- `MAX_LOADED_PERIODS = 8`.

Export `periodsToFetch(visiblePeriods, allPeriods)` and `evictPeriods(usedInOrder, pinned)` as pure functions, which is what the test above exercises.

- [ ] **Step 4: Make `PhotoGrid` a windowed renderer**

Replace its `sections` memo with `segmentsInRange(table, scrollTop - OVERSCAN, scrollTop + viewportHeight + OVERSCAN)`, `OVERSCAN = 1200`. Render an outer `div` of `height: table.totalHeight, position: relative`, and each visible day as a `section` at `position: absolute; top: segment.top`. A day whose tiles are absent renders placeholder blocks sized from `estimateDayHeight`'s row arithmetic and filled with nothing — the count is known, the colours are not.

Track `scrollTop` from the scrolling ancestor with a passive `scroll` listener and `requestAnimationFrame` coalescing, and call `onVisibleRangeChange` from the same handler.

Add the anchor compensation in a `useLayoutEffect` that holds the previous `SegmentTable` in a ref:

```ts
  useLayoutEffect(() => {
    const previous = previousTable.current
    previousTable.current = table
    if (!previous || previous.segments.length === 0) return
    const scroller = scrollerRef.current
    if (!scroller) return
    const delta = scrollDelta(previous, table, scroller.scrollTop)
    if (delta !== 0) scroller.scrollTop += delta
  }, [table])
```

Keep the sticky day header, the `SECTION_GAP` rhythm, and `PhotoTile` exactly as they are — `PhotoTile` takes an `asset` today but reads only fields `TimelineTile` also has; widen its prop type to accept either rather than rewriting it.

- [ ] **Step 5: Rewire `Timeline.tsx`**

Replace the `useInfiniteQuery` with `useTimeline(query, layoutOptions)`. The viewer's `openIndex` becomes a lookup through the segment table and the loaded day, and `step(delta)` loads the neighbouring period when it walks past an edge. The header count becomes `totalCount` from the spine — which is now exact, so the `+` suffix goes.

- [ ] **Step 6: Verify and commit**

Run: `cd ~/src/imogen-timeline/imogen-server && bun run verify`
Expected: PASS.

```bash
git add packages/web/src/
git commit -m "$(cat <<'MSG'
Render the window, not the library

The grid used to render every photograph it had ever fetched, so a long scroll
into a large library ended with a hundred thousand nodes in the document and a
justify pass over all of them on every resize. It now draws the days the
viewport touches and holds tiles for eight months at most.

When a day's real measurements replace its estimate, anything above the
viewport is compensated for before paint, so the picture under the reader
does not move.

Co-Authored-By: Claude with claude-opus-5[1m]
MSG
)"
```

### Task 13: The rail and the overview

**Files:**
- Create: `packages/web/src/components/TimelineRail.tsx`
- Create: `packages/web/src/components/TimelineOverview.tsx`
- Modify: `packages/web/src/routes/Timeline.tsx`
- Test: `packages/web/src/components/timelineRail.test.ts`

**Interfaces:**
- Consumes: `SegmentTable`, `dateAtOffset`, `offsetForDate` from Task 11; `useTimeline`'s `suspendFetching` from Task 12.
- Produces: `railTicks(table: SegmentTable, railHeight: number): Array<{ label: string; y: number; kind: 'year' | 'month' }>` exported from `TimelineRail.tsx` for testing; the two components.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, test } from 'bun:test'
import { buildSegments } from '../lib/timelineLayout.ts'
import { railTicks } from './TimelineRail.tsx'

const OPTIONS = { width: 1200, targetHeight: 208, gap: 4, sectionGap: 44, headerHeight: 40 }
const bucket = (date: string, count: number) => ({ date, count, coverAssetId: null })

describe('railTicks', () => {
  test('marks each year once, in order, inside the rail', () => {
    const table = buildSegments(
      [bucket('2013-01-01', 50), bucket('2012-06-01', 50), bucket('2011-08-14', 50)],
      new Map(),
      OPTIONS,
      new Map(),
    )
    const years = railTicks(table, 800).filter((t) => t.kind === 'year')
    expect(years.map((t) => t.label)).toEqual(['2013', '2012', '2011'])
    for (const tick of years) {
      expect(tick.y).toBeGreaterThanOrEqual(0)
      expect(tick.y).toBeLessThanOrEqual(800)
    }
  })

  test('a dense year takes more rail than a thin one', () => {
    const table = buildSegments(
      [
        ...Array.from({ length: 30 }, (_, i) => bucket(`2012-06-${String(i + 1).padStart(2, '0')}`, 300)),
        bucket('2011-08-14', 2),
      ],
      new Map(),
      OPTIONS,
      new Map(),
    )
    const [dense, thin] = railTicks(table, 800).filter((t) => t.kind === 'year')
    expect(thin!.y - dense!.y).toBeGreaterThan(400)
  })

  test('an empty table produces no ticks rather than throwing', () => {
    expect(railTicks(buildSegments([], new Map(), OPTIONS, new Map()), 800)).toEqual([])
  })
})
```

- [ ] **Step 2: Run and watch it fail**, then implement.

Run: `cd ~/src/imogen-timeline/imogen-server && bun test packages/web/src/components/timelineRail.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Build the rail**

`railTicks` maps each segment's `top` to `y = (top / table.totalHeight) * railHeight`, emitting a `year` tick at each year's first segment and `month` ticks only where the year's own span exceeds 44 px of rail. The component:

- is `position: fixed`, right edge, full height below the header, `role="slider"` with `aria-valuemin/max/now` in days;
- on pointer down calls `suspendFetching(true)`, on pointer move sets `scroller.scrollTop = (y / railHeight) * table.totalHeight` and floats a label reading `dateAtOffset(table, scrollTop)`;
- on pointer up calls `suspendFetching(false)` after a 150 ms timer;
- responds to `ArrowUp`/`ArrowDown` by stepping one month via `offsetForDate`;
- reflects the scroll position when the user scrolls normally rather than dragging.

- [ ] **Step 4: Build the overview**

`TimelineOverview` is an overlay with two levels — years, then the months of a chosen year — both rolled up from the same buckets, with `covers=true` supplying `coverAssetId` per period card. Choosing a month closes the overlay and sets `scrollTop` to `offsetForDate(table, firstDateIn(month))`. It renders `img` elements straight from `imogen.assets.urlFor(coverAssetId, 'thumbnail')` with `loading="lazy"`, and a card whose `coverAssetId` is null shows the count on the placeholder ground.

Open it from a control in the timeline header and with the `z` key; close with Escape.

- [ ] **Step 5: Verify and commit**

Run: `cd ~/src/imogen-timeline/imogen-server && bun run verify`
Expected: PASS.

```bash
git add packages/web/src/
git commit -m "$(cat <<'MSG'
A rail to aim with, and a way to stand back

The rail maps scroll position to date through the segment table, which makes
it proportional to how much was actually photographed: a year of nine thousand
frames takes more rail than a year of two hundred. Dragging it suspends bucket
fetching, so crossing fifteen years costs one request rather than forty.

The overview answers a different question — what is even back there — and
reads the same buckets, one request and a few hundred thumbnails.

Co-Authored-By: Claude with claude-opus-5[1m]
MSG
)"
```

### Task 14: Selection, the poll, and the other routes

**Files:**
- Modify: `packages/web/src/hooks/useSelection.ts`
- Modify: `packages/web/src/routes/Timeline.tsx`, `AlbumDetail.tsx`, `PersonDetail.tsx`, `SharedAlbum.tsx`, `VaultRoute.tsx`
- Modify: `packages/web/src/components/SelectionBar.tsx`, `ConfirmDialog.tsx` call sites
- Test: `packages/web/src/hooks/useSelection.test.ts`

**Interfaces:**
- Consumes: `AssetSelection`, `AssetFilter` from `@imogen/shared`; `useTimeline` from Task 12.
- Produces:

```ts
export type Selection =
  | { kind: 'ids'; ids: Set<string> }
  | { kind: 'all'; except: Set<string> }

export function useSelection(filter: Partial<AssetFilter>): {
  selection: Selection
  count: number                    // resolved against the spine's total
  isSelected: (id: string) => boolean
  toggle: (id: string, shiftKey: boolean) => void
  selectAll: () => void
  clear: () => void
  toRequest: () => AssetSelection
}
```

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, test } from 'bun:test'
import { toRequest, toggleIn, type Selection } from './useSelection.ts'

describe('toRequest', () => {
  test('an id selection sends its ids', () => {
    const selection: Selection = { kind: 'ids', ids: new Set(['a', 'b']) }
    expect(toRequest(selection, { favorite: true })).toEqual({ assetIds: ['a', 'b'] })
  })

  test('select-all sends the filter and what was unticked', () => {
    const selection: Selection = { kind: 'all', except: new Set(['a']) }
    expect(toRequest(selection, { favorite: true })).toEqual({
      query: { favorite: true },
      except: ['a'],
    })
  })

  test('select-all with nothing unticked sends an empty exclusion, not an absent one', () => {
    expect(toRequest({ kind: 'all', except: new Set() }, {})).toEqual({ query: {}, except: [] })
  })
})

describe('toggleIn', () => {
  test('unticking inside select-all adds to the exclusion set', () => {
    expect(toggleIn({ kind: 'all', except: new Set() }, 'a')).toEqual({
      kind: 'all',
      except: new Set(['a']),
    })
  })

  test('re-ticking removes it again', () => {
    expect(toggleIn({ kind: 'all', except: new Set(['a']) }, 'a')).toEqual({
      kind: 'all',
      except: new Set(),
    })
  })
})
```

- [ ] **Step 2: Run and watch it fail**, then implement `toRequest` and `toggleIn` as exported pure functions with the hook built on them.

Run: `cd ~/src/imogen-timeline/imogen-server && bun test packages/web/src/hooks/useSelection.test.ts`
Expected: FAIL — `toRequest` is not exported.

- [ ] **Step 3: Wire the mutations and the confirmation**

Every mutation in `Timeline.tsx` passes `toRequest()` instead of `[...selected]`. The trash confirmation states the resolved count — `count` from the hook, which is `totalCount - except.size` under select-all — so the dialog reads "Move 12,431 photos to the trash?" rather than "all photos".

- [ ] **Step 4: Narrow the pending poll**

Delete the `refetchInterval` from the timeline query. In `useTimeline`, add: collect the rendered tiles whose `status` is `pending` or `processing`, take the distinct periods holding them, cap at two, and `invalidateQueries` for exactly those bucket queries every 2,000 ms — and not at all when the set is empty.

Separately, poll `imogen.assets.stats()` on a 30,000 ms interval and on window focus; when `assetCount` differs from the last seen value, invalidate the spine query. Note in a comment why the spine and not the buckets: a backfill lands photographs in historical periods, so the counts move all over the timeline rather than at the head.

- [ ] **Step 5: Move the other routes onto the timeline**

`AlbumDetail`, `PersonDetail`, `SharedAlbum`, and `VaultRoute` each replace their asset source with `useTimeline` under the appropriate filter — `{ albumId }`, `{ personId }`, the share's scoped endpoints, and the vault's — and render the same windowed `PhotoGrid`. `PersonDetail` stops reading `person.photos` for its grid; `AlbumDetail` stops reading `album.assets`. Both may keep using those samples for a header or a cover.

- [ ] **Step 6: Verify and commit**

Run: `cd ~/src/imogen-timeline/imogen-server && bun run verify`
Expected: PASS.

```bash
git add packages/web/src/
git commit -m "$(cat <<'MSG'
Select all without naming everything, and stop polling the library

Selecting everything is now the filter you were looking at minus what you
unticked, so it costs one request whether it matches twelve photographs or
ninety thousand. The confirmation says which.

The pending-upload poll used to refetch every loaded page every two seconds,
which during an import is the whole library twice a second. It now refetches
only the periods holding something unfinished and on screen. The spine itself
is checked through a cheap count, because a backfill lands photographs in
1997 rather than at the head.

Albums, people, the vault and shared albums come along, being the same
timeline under a different filter.

Co-Authored-By: Claude with claude-opus-5[1m]
MSG
)"
```

### Task 15: Server pull request

- [ ] **Step 1:** Run `cd ~/src/imogen-timeline/imogen-server && bun run verify`. Must pass.
- [ ] **Step 2:** Push and open the PR:

```bash
cd ~/src/imogen-timeline/imogen-server
git push -u origin timeline-scrubbing
gh pr create --title "A timeline that can hold twenty years" --body "$(cat <<'MSG'
The web timeline rendered every photograph it had ever fetched and could only
reach 2009 by scrolling there from today. This gives it a spine, a window, and
two ways to aim.

**Server**
- `GET /assets/timeline` takes the filters every other listing takes, and can
  name a cover picture per period. Unfiltered, it answers exactly as before.
- `GET /assets/timeline/bucket` returns every tile in a month in one round
  trip, at about a quarter the bytes of the same assets as `Asset`s.
- Bulk mutations accept a filter with exclusions instead of an id list.
- Three endpoints stopped answering with the whole library: an album returned
  every asset it held as full `Asset`s, a person returned five hundred in uuid
  order with no `ORDER BY`, and a shared album scanned that unbounded array
  once per thumbnail request.

**Web**
- A pure geometry module turns day counts into an absolute segment table, so
  the scroll extent is right before the first thumbnail and every day that has
  been measured stays measured.
- The grid renders the window. Heights that change above the viewport are
  compensated for before paint.
- A date rail proportional to photograph density, and a year/month overview.
- The pending-upload poll no longer refetches the whole loaded library twice a
  second during an import.

Depends on ergofobe/imogen-sdk#<SDK PR NUMBER>.

Spec: `docs/superpowers/specs/2026-08-27-timeline-scrubbing-design.md`
Plan: `docs/superpowers/plans/2026-08-27-timeline-scrubbing.md`

🤖 Generated with [Claude Code](https://claude.com/claude-code)

https://claude.ai/code/session_015MF3M6T94djHJmr5neeZkv
MSG
)"
```

Substitute the real SDK PR number before running.

---

# Phase 4 — The terminal client

Repository: `imogen-cli`.

### Task 16: Buckets, eviction, and jumping

**Files:**
- Modify: `src/tui/app.rs`, `src/tui/mod.rs`, `src/tui/ui.rs`
- Test: the `mod tests` block at the foot of `src/tui/mod.rs`

**Interfaces:**
- Consumes: `TimelineBucket`, `TimelineTile`, `TimelineBucketQuery`, `Assets::timeline_bucket` from Task 3.
- Produces:
  - `App.buckets: Vec<TimelineBucket>`, `App.total: usize`
  - `App.window: TileWindow { base: usize, tiles: Vec<TimelineTile> }`
  - `App.thumb_order: VecDeque<String>` and `App.remember_thumbnail(id: String)`
  - `App.index_for_date(&str) -> Option<usize>`, `App.date_at_index(usize) -> Option<String>`
  - `App.periods_for_viewport() -> Vec<String>`
  - `Mode::JumpDate(String)`

- [ ] **Step 1: Write the failing tests**

Add to the existing `mod tests` in `src/tui/mod.rs`, alongside the helpers already there:

```rust
#[test]
fn thumbnails_are_evicted_once_the_cap_is_reached() {
    let mut app = viewing(&[]);
    app.grid_area = Rect::new(0, 0, 80, 24);
    for i in 0..(THUMBNAIL_CACHE + 10) {
        let id = format!("asset-{i}");
        app.thumbnails.insert(id.clone(), Arc::new(test_image()));
        app.remember_thumbnail(id);
    }
    assert!(app.thumbnails.len() <= THUMBNAIL_CACHE);
}

#[test]
fn the_thumbnail_on_screen_is_never_the_one_evicted() {
    let mut app = viewing(&[]);
    app.thumbnails.insert("keep".into(), Arc::new(test_image()));
    app.remember_thumbnail("keep".into());
    for i in 0..(THUMBNAIL_CACHE + 10) {
        let id = format!("asset-{i}");
        app.thumbnails.insert(id.clone(), Arc::new(test_image()));
        app.remember_thumbnail(id);
    }
    app.remember_thumbnail("keep".into());
    assert!(app.thumbnails.contains_key("keep"));
}

#[test]
fn jumping_to_a_date_lands_on_it() {
    let mut app = viewing(&[]);
    app.buckets = vec![bucket("2011-08-15", 10), bucket("2011-08-14", 10)];
    app.recount();
    assert_eq!(app.index_for_date("2011-08-14"), Some(10));
}

#[test]
fn jumping_to_a_day_with_no_photographs_lands_on_the_nearest_older_one() {
    let mut app = viewing(&[]);
    app.buckets = vec![bucket("2011-08-15", 10), bucket("2011-08-10", 10)];
    app.recount();
    assert_eq!(app.index_for_date("2011-08-12"), Some(10));
}

#[test]
fn jumping_past_the_end_lands_on_the_oldest_photograph() {
    let mut app = viewing(&[]);
    app.buckets = vec![bucket("2011-08-15", 10)];
    app.recount();
    assert_eq!(app.index_for_date("1999-01-01"), Some(9));
}

#[test]
fn an_empty_library_has_nowhere_to_jump_to() {
    let app = viewing(&[]);
    assert_eq!(app.index_for_date("2011-08-14"), None);
}

#[test]
fn the_viewport_asks_only_for_the_periods_it_covers() {
    let mut app = viewing(&[]);
    app.buckets = vec![bucket("2011-09-01", 200), bucket("2011-08-14", 200), bucket("2011-07-01", 200)];
    app.recount();
    app.columns = 4;
    app.grid_area = Rect::new(0, 0, 80, 24);
    app.selected = 0;
    let periods = app.periods_for_viewport();
    assert!(periods.contains(&"2011-09".to_string()));
    assert!(!periods.contains(&"2011-07".to_string()));
}
```

Add a `bucket(date, count)` helper and a `test_image()` helper beside the existing `png_bytes` and `asset` helpers.

- [ ] **Step 2: Run and watch them fail**

Run: `cd ~/src/imogen-timeline/imogen-cli && cargo test`
Expected: FAIL — no `remember_thumbnail`, no `THUMBNAIL_CACHE`, no `index_for_date`.

- [ ] **Step 3: Implement the state changes**

In `src/tui/app.rs`:

```rust
/// How many decoded grid thumbnails to keep. Enough that scrolling back a screen or two
/// is instant; few enough that a twenty-year library does not become a memory leak. The
/// map used to grow without bound, and it holds decoded images.
pub const THUMBNAIL_CACHE: usize = 256;
```

Add `thumb_order: VecDeque<String>` beside the existing `preview_order`, and `remember_thumbnail` mirroring how previews are evicted today — that pattern is already in this file and is the one to follow.

Replace `assets: Vec<Asset>` with `buckets: Vec<TimelineBucket>`, `total: usize`, and `window: TileWindow`. Add `recount()` summing bucket counts into `total`. `index_for_date` walks the buckets accumulating counts and returns the first index of the first bucket whose date is less than or equal to the wanted date, clamped to `total - 1`; `None` when there are no buckets. `date_at_index` is its inverse. `periods_for_viewport` maps the visible index range through `date_at_index` to distinct `YYYY-MM` strings, plus one period either side.

`move_by`, `keep_selection_visible`, `visible_ids`, and `pending_on_screen` all move to global indices resolved through `window`. Delete `wants_more`.

Add `Mode::JumpDate(String)` to the `Mode` enum with the doc comment style of its neighbours.

- [ ] **Step 4: Implement the loop and the drawing**

In `src/tui/mod.rs`, replace the `load_page` / cursor flow with `load_bucket(ctx, period)` calling `client.assets.timeline_bucket`, and a `load_buckets(ctx)` for the spine, fired once on start and on scope change. Drive fetching from `app.periods_for_viewport()`. Handle `g` opening `Mode::JumpDate`, Enter parsing through `crate::dates` and calling `index_for_date`, Escape abandoning — exactly as `Mode::Search` does.

In `src/tui/ui.rs`, draw a one-column gutter at the right of the grid with year marks and the cursor's position, and render the jump prompt in the same style as the search prompt.

- [ ] **Step 5: Run and watch them pass**

Run: `cd ~/src/imogen-timeline/imogen-cli && cargo test && cargo clippy -- -D warnings`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/
git commit -m "$(cat <<'MSG'
Hold a window of the library, not all of it

The browser kept every asset it had paged in and every thumbnail it had ever
decoded, the second of those in a map that was never evicted from. On a
twenty-year library that is a leak with a picture in it.

It now learns the shape of the timeline from the day buckets, holds the tiles
the viewport covers, and caps decoded thumbnails the way previews were already
capped. `g` jumps to a date, landing on the nearest day that has photographs
when the one asked for does not, and a year rail down the right edge says
where you are.

Co-Authored-By: Claude with claude-opus-5[1m]
MSG
)"
```

### Task 17: CLI pull request

- [ ] **Step 1:** Run `cd ~/src/imogen-timeline/imogen-cli && cargo test && cargo clippy -- -D warnings`. Must pass.
- [ ] **Step 2:** Push and open the PR:

```bash
cd ~/src/imogen-timeline/imogen-cli
git push -u origin timeline-scrubbing
gh pr create --title "A terminal browser that can hold twenty years" --body "$(cat <<'MSG'
The browser kept every asset it had paged in and every thumbnail it had ever
decoded — the latter in a map with no eviction at all, holding decoded images.

It now learns the timeline's shape from the day buckets, holds only the tiles
the viewport covers, and caps the thumbnail cache the way the preview cache
was already capped. `g` jumps to a date — "aug 2011", "2011-08-14", or
"2011" — landing on the nearest day with photographs when the one asked for
has none. A year rail down the right edge says where you are, and `[` and `]`
step whole years.

Depends on ergofobe/imogen-sdk#<SDK PR NUMBER>.

Spec: `imogen-server/docs/superpowers/specs/2026-08-27-timeline-scrubbing-design.md`

🤖 Generated with [Claude Code](https://claude.com/claude-code)

https://claude.ai/code/session_015MF3M6T94djHJmr5neeZkv
MSG
)"
```

Substitute the real SDK PR number before running.
