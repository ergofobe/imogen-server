# Timeline scrubbing and windowed rendering — Design Document

**Date:** 2026-08-27
**Repos:** `ergofobe/imogen-sdk`, `ergofobe/imogen-server`, `ergofobe/imogen-cli`
**Status:** Approved for implementation

## 1. Purpose

A production library of twenty-odd years of photographs does not fit the assumptions
both clients were built on. The web timeline accumulates every fetched page into one
array and renders all of it; the terminal browser grows an unbounded `Vec<Asset>` and an
unbounded map of decoded thumbnails. Neither offers any way to reach 2009 except
scrolling from today.

This design gives both clients the same two abilities:

1. **Know the shape of the whole timeline before loading a single photograph**, so the
   scroll extent is correct from the first paint and a scrubber can be proportional to
   real photo density.
2. **Render and hold only a window**, so memory and DOM cost track the viewport rather
   than the library.

Success means: a cold load paints an accurate date rail before any thumbnail arrives; a
drag from today to 2004 issues a couple of requests rather than forty; and a hundred
thousand photographs cost the same DOM as a thousand.

## 2. Scope

**In scope:** the day-bucket spine and a lean per-period tile endpoint; windowed
rendering in the web grid; a draggable date rail and a zoomed-out year/month overview;
the equivalent in the TUI (windowed grid, thumbnail eviction, jump-to-date, year rail);
selection by query for bulk mutations; narrowing the pending-asset poll; and extending
all of it to albums, people, search, the vault, and shared albums.

**Explicitly out of scope:** changing how photographs are laid out (`justify()` stays as
it is), local-timezone day boundaries (see §9.2), video transcoding, and any change to
ingest.

## 3. The spine

Everything rests on one idea: the client learns the timeline's shape up front, cheaply.

### 3.1 Day buckets — existing, extended

`GET /assets/timeline` already returns `[{date, count}]`, one row per day, newest first,
and is described in its own route as existing "so a client can size its scrollbar before
loading anything". Nothing consumes it today. For a twenty-year library it is roughly
5,000–7,000 rows, about 250 KB raw and 40 KB gzipped, fetched once per scope.

Day granularity — not month — is deliberate. Each day is a sticky header plus a ragged
final row, and those two together are the bulk of the height-estimation error. Months
and years are a client-side rollup; there is no second aggregate endpoint.

Two additive, backwards-compatible parameters:

- The `AssetFilter` set (§3.3), so the spine can describe an album, a person, a search,
  or the trash rather than only the whole library.
- `covers=true`, adding a nullable `coverAssetId` to each bucket, for the overview's
  period cards. The cover is the newest `ready` asset in the bucket, and is null when the
  bucket holds none — a period still being processed shows a count without a picture
  rather than disappearing.

Callers passing neither get today's response byte for byte.

### 3.2 Tiles — new

`GET /assets/timeline/bucket?period=YYYY-MM` (also accepting `YYYY-MM-DD`) returns a
lean projection of every asset in that period, ordered `capturedAt desc, id desc` — the
same order as the timeline and as `assets_timeline_idx`:

```
TimelineTile = {
  id, capturedAt, width, height, type, status,
  favorite, duration, placeholderColor, livePhotoVideoId
}
```

Field names are spelled out rather than abbreviated. The raw payload is around 30%
larger than single-letter keys; gzipped the difference is noise, and five typed SDKs
plus an OpenAPI description have to stay readable.

A heavy 1,500-photograph month is roughly 90 KB over the wire in one round trip, against
roughly 2 MB and three round trips for the same month through `GET /assets` — `Asset`
carries checksum, exif, both captured-at correction fields, and filenames, none of which
a grid tile reads.

The endpoint accepts `cursor` and `limit` (default 5,000) and returns `nextCursor`,
because a scanned-archive import can land forty thousand photographs on one date and
that cannot be a single response.

It takes the same `AssetFilter`, so one implementation serves every surface. Where
`period` and the filter's own `takenAfter`/`takenBefore` are both present they intersect;
`period` never widens a filter.

### 3.3 Shared filter and selection schemas

```
AssetFilter    = AssetQuery minus cursor/limit/sort/order
                 (q, type, albumId, personId, favorite, archived, trashed,
                  takenAfter, takenBefore, bbox)

AssetSelection = { assetIds?: uuid[<=1000],
                   query?: AssetFilter,
                   except?: uuid[<=10000] }
                 refined: exactly one of assetIds | query
```

`personId` is new to the filter set and is what lets `PersonDetail` join the timeline
path (§7.2).

`except` is capped at 10,000. A selection that deselects more than that is not a
selection any interface should offer, so clients cap the exclusion set and fall back to
sending explicit ids; the server rejects a longer one rather than silently truncating.

`AssetSelection` is a struct with two optional fields and a refinement rather than a
discriminated union: a union costs a Rust enum, a Swift enum with associated values, and
a Kotlin sealed class, and buys nothing here.

## 4. Web client

### 4.1 Separating geometry from rendering

`PhotoGrid` currently groups by day, computes justified rows, and renders every tile.
It splits at a hard boundary:

**`lib/timelineLayout.ts`** — pure, no React. Takes day buckets, viewport width, row
target, gaps, and a `Map<period, TimelineTile[]>` of what is loaded. Returns a **segment
table** — one entry per day, `{date, top, height, measured}` — and a `totalHeight`.

- A loaded day gets exact geometry from `justify()`, which already returns a `top` per
  row and whose own comment says it does so "so a virtualiser can position rows
  absolutely". It was built for this.
- An unloaded day is estimated: `ceil(count / perRow) * (rowHeight + gap) + headerHeight`,
  with `perRow ≈ width / (targetHeight * 1.4)`.

Being pure, it is tested without a DOM, beside the existing `justify.test.ts`.

**`PhotoGrid`** becomes a windowed renderer: a spacer of `totalHeight` and absolutely
positioned sections for only the days intersecting
`[scrollTop − overscan, scrollTop + viewportHeight + overscan]`. Node count becomes a
function of the viewport, not the library.

### 4.2 Anchor preservation

This is the one thing that must not go wrong. When a bucket's real tiles arrive, its
measured height replaces its estimate and everything below shifts. If that bucket sits
above the viewport, content jumps under the reader.

A `useLayoutEffect` diffs the new segment table against the old; where any changed
segment has `top < scrollTop`, it applies the accumulated delta with `scrollBy` in the
same frame, before paint.

Measured heights are cached in a `Map<date, number>` that is **never evicted**, even
when the tiles themselves are. A region visited once is stable forever after: the
timeline settles as it is explored rather than re-jittering on every return.

### 4.3 Loading and eviction

Fetch the month bucket under the viewport plus one either side. Retain the eight
most-recently-used buckets' tile arrays and evict the rest; measured heights survive, as
above.

While the rail is being dragged, bucket fetching is suspended entirely and the grid
paints placeholder-colour blocks sized from the bucket counts. Fetching resumes about
150 ms after the drag settles. A fast drag across fifteen years must not issue forty
requests.

### 4.4 The rail

Fixed to the right edge, mapping `scrollTop` to date through the segment table — which
makes it proportional to photograph density for free: a year of nine thousand frames
takes more rail than a year of two hundred. Year labels anchor at each year's first
segment; month sub-ticks appear where a year has the room. Dragging sets `scrollTop`
directly and floats a date label at the pointer. It is a `role="slider"` with arrow keys
stepping by month, so it is reachable without a pointer.

### 4.5 The zoomed-out overview

An overlay reading the same buckets rolled up to years and months, with `covers=true`
giving each period card a representative thumbnail. Two levels — years, then the months
of a year — and choosing a month closes the overlay and sets `scrollTop` to that
segment's `top`. It never renders a photo grid of its own, so it costs one request and a
few hundred thumbnails.

### 4.6 Two things windowing breaks

`Timeline.tsx` today finds the open photograph with
`assets.findIndex(a => a.id === openId)` and hands `useSelection` every id in the
library. Neither survives a windowed list.

- **The viewer** steps by global timeline position derived from the segment table and
  the loaded bucket, loading the neighbouring bucket when it walks off an edge.
- **Selection** stores ids explicitly, and "select all" becomes a scope-level flag with
  an exclusion set, resolved server-side (§5).

## 5. Selection by query

`POST /assets/trash`, `POST /assets/restore`, `POST|DELETE /albums/{id}/assets`, and the
vault move routes take `AssetSelection` where they take `IdsBody` today. The id form is
unchanged, so every existing caller and all five SDK surfaces keep working.

When `query` is present the server runs one set-based statement —
`update assets set deleted_at = now() where <filters> and id <> all(except)` — and never
materialises ninety thousand uuids in a request body, in a `Set`, or in memory. The
existing `{count}` responses already have the right shape.

Two consequences that must be handled rather than discovered:

- `vault.moveIn` re-encrypts per asset and then calls `faces.forgetAsset` in a loop. By
  query that becomes ninety thousand sequential calls, so it needs a set-based
  `forgetAssets` and a queued job rather than an inline move.
- A by-query trash feels irreversible. The web confirmation must state the resolved
  count — "Move 12,431 photos to the trash?" — fetched before the mutation, never
  "all photos".

## 6. Terminal client

The TUI has the easier geometry: its grid is uniform tiles
(`columns = width / tile_width`) with no day headers and no justified rows, so a global
index maps to a row by division and the total is `sum(bucket.count)`. No estimation, no
jitter, no anchor compensation — geometry is exact the moment the buckets land.

- `assets: Vec<Asset>` becomes `buckets: Vec<Bucket>` plus a
  `window: { base: usize, tiles: Vec<TimelineTile> }` around the cursor. `selected` and
  `move_by` operate on global indices against `total`.
- `thumbnails: HashMap` gains the LRU discipline `previews` already has — a
  `thumb_order: VecDeque<String>` capped at `max(256, 4 × visible tiles)`. This is the
  single most valuable change for a large library today: that map holds *decoded*
  `DynamicImage`s and currently grows without bound.
- The viewer still needs a full `Asset`, so opening one fetches it through the existing
  `load_asset` path and the existing `PREVIEW_CACHE`. Tiles carry only what the grid
  draws.
- `g` opens `Mode::JumpDate(String)`, following the shape of the existing `Mode::Search`
  and `Mode::PickerPath`, parsed through `src/dates.rs` — so "aug 2011", "2011-08-14",
  and "2011" all work, the same vocabulary as `imogen timeline --after`.
- A right-hand gutter draws the year rail in block characters with the cursor's position
  marked; `[` and `]` step whole years.
- `wants_more()` — cursor-at-the-end paging — is removed, replaced by "which buckets does
  the viewport cover".

## 7. The other surfaces

Albums, people, search, the vault, and shared albums are the same timeline under a
different filter, so they inherit windowing, the rail, and the overview from one
implementation. Wiring them up exposes three unbounded payloads that are one bug in
three places.

### 7.1 Albums

`albums.getWithAssets` returns every asset in an album as a full `Asset`, unbounded. A
thirty-thousand-photograph album is roughly a 24 MB JSON response. The grid moves to the
timeline path under an `albumId` filter.

### 7.2 People

`faces.photosOf` caps at 500 but uses `selectDistinctOn([assets.id])` with no `orderBy`,
so a person with three thousand photographs shows an arbitrary five hundred **in uuid
order**. `PhotoGrid` then groups those by day, which reads as scattered noise. It is not
the five hundred most recent; it is five hundred at random. The grid moves to the
timeline path under the new `personId` filter.

### 7.3 Shared albums

`GET /share/:slug/assets/:assetId/:variant` guards access with
`share.album.assets.some(a => a.id === assetId)` — a linear scan of that same unbounded
array, **per thumbnail request**. A thirty-thousand-photograph album performs on the
order of 30,000 × 30,000 comparisons over one page load. The guard becomes an `exists`
query against `album_assets`, and the share gains a scoped bucket route.

### 7.4 What stays in the contract

`AlbumWithAssets.assets` and `PersonWithPhotos.photos` remain — removing them breaks
five SDKs — but become an explicitly capped and explicitly *ordered* cover sample,
documented as such. No grid reads them.

## 8. The pending-asset poll

`Timeline.tsx` sets `refetchInterval: 2000` on the infinite query, so a single pending
asset re-fetches every loaded page every two seconds. During a bulk import that is the
whole loaded library, twice a second.

It becomes: collect the pending or processing tiles **currently rendered**, refetch only
the buckets containing them, capped at two buckets per tick.

The spine itself drifts during an import, and in an unusual way: a backfill lands
photographs in *historical* buckets, so day counts change across the whole timeline
rather than at the head. The rule is to poll `GET /assets/stats` every thirty seconds and
on window focus, and to invalidate the spine when `assetCount` moves — one cheap
aggregate rather than a 250 KB refetch on a timer. When the new spine lands, segments
above the viewport change height, which §4.2 already handles.

## 9. Findings recorded, not acted on

### 9.1 No migration is required

`assets_timeline_idx` is `(owner_id, captured_at desc, id desc)`, partial on live
assets — exactly right for both the bucket aggregate and date-range windows. The
`to_char(...)` grouping cannot use the index for grouping itself, so a 500,000-row spine
query will take a few hundred milliseconds; cached for thirty seconds that is
acceptable. If it proves not to be, a `date_trunc('day', captured_at)` expression index
is the escape hatch — to be measured before being added, not added speculatively.

### 9.2 UTC day boundaries are consistent and must stay so

The server buckets with `at time zone 'UTC'`; the web's `groupByDay` does
`capturedAt.slice(0, 10)`, which is also UTC. They agree, and that agreement is what
makes height estimation sound. A photograph taken at 9pm in a western timezone therefore
files under the following day — a pre-existing wart, not a new one. If a local-timezone
`tz` parameter is ever added it must change both together, or the spine desynchronises
from the layout. This warrants a comment in both places and nothing more.

## 10. Testing

- **Geometry**, the highest-risk piece, gets the most attention, beside the existing
  `justify.test.ts`: estimated against measured heights, monotonic `top` values, the
  anchor-compensation delta, empty days, and a single day holding forty thousand
  photographs.
- **Server** work extends the `timeline buckets` describe already in
  `media/assets.test.ts`, adds bucket-detail cases and the filter matrix
  (album, person, `q`, trashed, archived), and asserts a by-query mutation touches
  exactly the intended rows, `except` included.
- **SDKs**: each port's conformance test walks `conformance/endpoints.json` and picks up
  the new rows automatically; the `models.json` addition forces every port to declare
  `TimelineTile`.
- **TUI** tests are rewritten against tiles and gain eviction under pressure and jumping
  to a date with no photographs (which lands on the nearest day that has some, in the
  direction of travel).
- **Manual**: the real library is the acceptance test. A cold load must paint the rail
  before any thumbnail; a drag from today to 2004 must not issue more than a couple of
  bucket requests.

Gate per repository before any of it is called done: `bun run verify` in `imogen-sdk` and
`imogen-server`, `cargo test && cargo clippy` in `imogen-cli`.

## 11. Delivery

### 11.1 Worktrees

Both dependants reference the SDK by relative path — `"@imogen/shared":
"file:../imogen-sdk/typescript/packages/shared"` and
`imogen-sdk = { path = "../imogen-sdk/rust" }` — so a worktree placed inside a repository
would break resolution. The three worktrees keep the sibling arrangement and the exact
directory names:

```
~/src/imogen-timeline/
├── imogen-sdk/      worktree of ~/src/imogen/imogen-sdk      ┐
├── imogen-server/   worktree of ~/src/imogen/imogen-server   ├── branch: timeline-scrubbing
└── imogen-cli/      worktree of ~/src/imogen/imogen-cli      ┘
```

Each needs its own `bun install`; the Rust worktree shares a `CARGO_TARGET_DIR` so it
does not rebuild the world. The production checkouts stay on `main` and keep serving the
running import.

### 11.2 Phases

The dependency chain is what makes a subagent split safe.

| Phase | Agents | Work |
| --- | --- | --- |
| 0 | serial | The contract: `conformance/endpoints.json`, `models.json`, and the shared schemas (`AssetFilter`, `AssetSelection`, `TimelineTile`). |
| 1 | 5 parallel | SDK ports: TypeScript, Rust, Python, Swift, Kotlin. One language directory each, no shared files. |
| 2 | 2 parallel | Server: timeline and bucket endpoints with `AssetFilter` plumbing; `AssetSelection` on bulk mutations plus the §7 payload fixes. |
| 3 | 1, then 3 parallel | Web: `timelineLayout.ts` alone and first, since everything consumes its interface; then windowing, rail and overview, and selection/poll/other-routes. |
| 4 | 1 | TUI, which is cohesive enough that splitting it would cost more than it saves. |

Phase 0 landing before any fan-out is the crux: five agents inventing their own field
names for one wire format is the obvious way this goes wrong.
