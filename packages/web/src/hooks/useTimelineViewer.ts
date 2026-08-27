import type { Asset, TimelineTile } from '@imogen/shared'
import { useQuery } from '@tanstack/react-query'
import { useCallback, useEffect, useMemo, useRef } from 'react'
import { imogen } from '../lib/client.ts'
import type { SegmentTable } from '../lib/timelineLayout.ts'
import { useViewerParam } from './useViewerParam.ts'

/**
 * Opening one photograph out of a windowed timeline, and stepping along it.
 *
 * A tile carries ten fields; the viewer wants exif, place, description and the corrected
 * date. Fetching the one photograph that is open costs a request the grid would otherwise
 * have paid for every photograph in the month.
 *
 * Stepping is the part that needs care. `ordered` holds only the months in hand, so a step
 * off the end of it is not the end of the library — the spine says there is more. The step
 * is remembered, the next month is asked for, and it is taken when that month lands. And
 * `hasNext`/`hasPrevious` are judged against the whole segment table rather than against
 * `ordered`, or the arrows would go dark at the seam between two months and stepping across
 * one would look like the end of the album.
 */
export function useTimelineViewer(options: {
  table: SegmentTable
  ordered: TimelineTile[]
  /** From `useTimelineGrid`; asks for one more month without unpinning what is on screen. */
  requestNeighbour: (date: string, direction: number) => string | null
  /**
   * How to fetch one whole photograph. A shared link supplies its own share-scoped fetch,
   * because a visitor has no session and must never reach an authenticated endpoint.
   */
  fetchAsset?: (id: string) => Promise<Asset>
  /** Separates one scope's asset cache from another's, as `TimelineSource.key` does. */
  scope?: string
}) {
  const { table, ordered, requestNeighbour, fetchAsset, scope = 'library' } = options
  const { openId, open, replace: showPhoto, close } = useViewerParam()

  const viewing = useQuery({
    queryKey: ['asset', scope, openId],
    queryFn: () => (fetchAsset ?? ((id: string) => imogen.assets.get(id)))(openId as string),
    enabled: Boolean(openId),
  })
  const asset = openId && viewing.data?.id === openId ? viewing.data : null

  const openIndex = useMemo(
    () => (openId ? ordered.findIndex((tile) => tile.id === openId) : -1),
    [ordered, openId],
  )

  /** Set when a step ran off the end of the loaded months; taken once one more arrives. */
  const pendingStep = useRef<number | null>(null)

  const step = useCallback(
    (delta: number) => {
      if (openIndex < 0) return
      const next = ordered[openIndex + delta]
      if (next) {
        pendingStep.current = null
        showPhoto(next.id)
        return
      }
      // Off the edge of what is loaded. The next photograph exists — the spine says so —
      // but its month has not been fetched, so ask for it and take the step when it lands.
      const edge = delta > 0 ? ordered.at(-1) : ordered[0]
      if (!edge) return
      if (!requestNeighbour(edge.capturedAt.slice(0, 10), delta)) return
      pendingStep.current = delta
    },
    [ordered, openIndex, showPhoto, requestNeighbour],
  )

  useEffect(() => {
    const delta = pendingStep.current
    if (delta === null || openIndex < 0) return
    const arrived = ordered[openIndex + delta]
    if (!arrived) return
    pendingStep.current = null
    showPhoto(arrived.id)
  }, [ordered, openIndex, showPhoto])

  const edges = useMemo(() => atEdges(table, ordered, openIndex), [table, ordered, openIndex])

  return { openId, asset, open, close, step, ...edges }
}

/**
 * Whether there is anything either side of the open photograph, judged against the whole
 * timeline rather than the loaded months: the arrows have to stay lit at the seam between
 * two months, or stepping across one would look like the end of the library.
 */
function atEdges(
  table: SegmentTable,
  ordered: TimelineTile[],
  openIndex: number,
): { hasPrevious: boolean; hasNext: boolean } {
  if (openIndex < 0) return { hasPrevious: false, hasNext: false }
  const dayOf = (tile: TimelineTile | undefined) => tile?.capturedAt.slice(0, 10)
  const indexOfDay = (date: string | undefined) =>
    date === undefined ? -1 : table.segments.findIndex((segment) => segment.date === date)

  const first = indexOfDay(dayOf(ordered[0]))
  const last = indexOfDay(dayOf(ordered.at(-1)))
  return {
    hasPrevious: openIndex > 0 || first > 0,
    hasNext: openIndex < ordered.length - 1 || (last >= 0 && last < table.segments.length - 1),
  }
}
