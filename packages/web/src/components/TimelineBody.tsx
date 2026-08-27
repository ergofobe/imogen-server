import type { AssetFilter, TimelineTile } from '@imogen/shared'
import type { TimelineSource } from '../hooks/useTimeline.ts'
import type { TimelineGrid } from '../hooks/useTimelineGrid.ts'
import { EmptyState } from './EmptyState.tsx'
import { PhotoGrid } from './PhotoGrid.tsx'
import { TimelineOverview } from './TimelineOverview.tsx'
import { TimelineRail } from './TimelineRail.tsx'
import { TimelineSkeleton } from './TimelineSkeleton.tsx'

/**
 * The grid, the rail and the overview, which every timeline view renders identically.
 *
 * Kept together because they are one thing: the rail and the overview both scroll the
 * grid, so all three need the same element and the same segment table, and a route that
 * assembled them itself would be a route that could get one of the three wrong.
 *
 * "Nothing here" is decided HERE rather than by each route, because a route cannot see the
 * difference between the two states that produce a zero. `totalCount` is 0 while the spine
 * is in the air and 0 when the spine says the view is empty, and every route that gated its
 * own skeleton on some smaller metadata query got the first one wrong: the metadata landed
 * first, the skeleton stopped, and the page announced that an album of fifteen hundred
 * photographs was empty for as long as the spine took. On a shared link that was a
 * stranger's first paint of a gift reading "This album has no photos in it."
 *
 * So an empty state is only ever drawn once the spine has actually answered.
 */
export function TimelineBody({
  grid,
  filter,
  source,
  empty,
  isSelected,
  selecting,
  selectable = true,
  onOpen,
  onToggleSelect,
}: {
  grid: TimelineGrid
  /** What the overview's covers spine should describe — the same library the grid shows. */
  filter: Partial<AssetFilter>
  source?: TimelineSource
  empty: { headline: string; body: string; action?: React.ReactNode }
  isSelected?: (id: string) => boolean
  selecting?: boolean
  /** A shared page has nothing to do with a selection, so it does not offer one. */
  selectable?: boolean
  onOpen: (tile: TimelineTile) => void
  onToggleSelect?: (tile: TimelineTile, shiftKey: boolean) => void
}) {
  // Still asking. A skeleton says "not yet"; an empty state says "never", and only one of
  // those is true before the answer arrives.
  if (grid.isPending) return <TimelineSkeleton />

  if (grid.totalCount === 0) {
    return <EmptyState headline={empty.headline} body={empty.body} action={empty.action} />
  }

  return (
    <>
      <PhotoGrid
        table={grid.table}
        tiles={grid.tiles}
        options={grid.options}
        attachContainer={grid.attachGrid}
        isSelected={isSelected}
        selecting={selecting}
        selectable={selectable}
        onOpen={onOpen}
        onToggleSelect={onToggleSelect ?? (() => {})}
        onVisibleRangeChange={grid.onVisibleRangeChange}
      />

      <TimelineRail table={grid.table} grid={grid.grid} suspendFetching={grid.suspendFetching} />

      {grid.showingOverview && (
        <TimelineOverview
          table={grid.table}
          filter={filter}
          source={source}
          grid={grid.grid}
          onClose={() => grid.setShowingOverview(false)}
        />
      )}
    </>
  )
}

/** The count and the Overview button, which four of the five views want above the grid. */
export function TimelineCount({
  totalCount,
  onShowOverview,
}: {
  totalCount: number
  onShowOverview: () => void
}) {
  if (totalCount === 0) return null
  return (
    <div className="flex items-baseline gap-4">
      {/* The spine counts every day the filter matches, so this is the number, not a floor. */}
      <span className="label-micro">
        {totalCount.toLocaleString()} {totalCount === 1 ? 'photo' : 'photos'}
      </span>
      <button
        type="button"
        onClick={onShowOverview}
        className="rounded-lg border border-line px-2.5 py-1 text-sm transition hover:bg-sunken"
      >
        Overview
        <kbd className="label-micro ml-2 text-muted">z</kbd>
      </button>
    </div>
  )
}
