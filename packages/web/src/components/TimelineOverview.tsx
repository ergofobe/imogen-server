import type { AssetFilter } from '@imogen/shared'
import { useQuery } from '@tanstack/react-query'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useAssetUrls } from '../lib/assetUrls.tsx'
import { imogen } from '../lib/client.ts'
import { formatMonthKey } from '../lib/format.ts'
import { scrollGridTo } from '../lib/scroller.ts'
import { offsetForDate, type SegmentTable } from '../lib/timelineLayout.ts'
import { type PeriodCard, rollUpPeriods } from '../lib/timelinePeriods.ts'

/**
 * Standing back from the timeline.
 *
 * The rail answers "take me to roughly there". This answers the question a person asks
 * first, before they know where "there" is: what is even back there. Twenty years of
 * scrolling cannot answer it, and neither can a rail — a rail is a pointing device, and
 * you have to already know what you are pointing at.
 *
 * Two levels, because two is how far a person can hold a photo library in their head at
 * once: the years, then the months of one year. Both are rolled up from the same day
 * buckets the timeline is already built out of, so the overview is never a second opinion
 * about what the library contains.
 */

type Props = {
  table: SegmentTable
  /** The filter the timeline is showing, so the covers spine describes the same library. */
  filter: Partial<AssetFilter>
  /** The grid, so landing on a month writes the same scroll position `PhotoGrid` reads. */
  grid: HTMLElement | null
  onClose: () => void
}

/**
 * Covers are asked for here rather than folded into the timeline's own spine.
 *
 * `covers=true` adds a uuid to every one of seven thousand day rows — around 350KB on top
 * of a 250KB spine, more than doubling the request that has to land before the timeline
 * can be laid out at all. The timeline never reads those uuids. So the overview fetches
 * its own copy, and only when it is first opened: a reader who never opens it pays
 * nothing, and one who does pays once. Which cache key that copy lives under turned out
 * to matter a great deal — see the query below.
 *
 * The alternative — one spine with covers, shared — was rejected for making every cold
 * load, on every device, carry a payload for a panel most loads never open. Deferring the
 * cost to the moment someone asks for it is the whole trade.
 */
export function TimelineOverview({ table, filter, grid, onClose }: Props) {
  const { url } = useAssetUrls()
  const [year, setYear] = useState<string | null>(null)
  const closeButton = useRef<HTMLButtonElement>(null)

  /*
   * Once, on open. An inline `ref={(node) => node?.focus()}` looks equivalent and is not:
   * React detaches and reattaches an inline ref on every render, so it re-focused when the
   * covers query resolved and again on every drill-in — snatching focus back to Close from
   * whichever card a keyboard reader had tabbed to.
   */
  useEffect(() => closeButton.current?.focus(), [])

  /*
   * Keyed outside the `['timeline']` prefix, on purpose, and it cost a browser to find out
   * why it has to be.
   *
   * `useTimeline`'s `reload` invalidates that whole prefix, and the poll that watches a
   * still-processing upload calls it every two seconds. Under a `['timeline', …, 'covers']`
   * key this query is active whenever the overlay is open, so every one of those ticks
   * refetched it: sixteen fetches of the heaviest request in the app during one reading of
   * the overview, none of which changed a single cover.
   *
   * The cost of standing outside the prefix is that a mutation does not push new covers
   * into an overlay that is already open. That is the right way round. The overlay is
   * opened, read, and closed in seconds; it remounts every time, and `staleTime` is the
   * spine's own, so a cover corrected by a mutation is back within thirty seconds. A
   * thirty-second-old thumbnail is not a defect anybody can see. Half a megabyte a minute
   * is.
   */
  const covers = useQuery({
    queryKey: ['timelineCovers', filter],
    queryFn: () => imogen.assets.timeline({ ...filter, covers: true }),
    staleTime: 30_000,
  })

  /*
   * Until the covers land, the segment table is a complete answer for everything except
   * the pictures — it carries the same days and the same counts. Drawing from it means the
   * overview is populated the instant it opens and fills with thumbnails a moment later,
   * rather than showing a spinner over data the page already had in hand.
   */
  const buckets = covers.data?.buckets ?? table.segments

  const cards = useMemo(
    () =>
      year
        ? rollUpPeriods(
            buckets.filter((bucket) => bucket.date.startsWith(`${year}-`)),
            'month',
          )
        : rollUpPeriods(buckets, 'year'),
    [buckets, year],
  )

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const goToMonth = useCallback(
    (card: PeriodCard) => {
      // Written before the overlay goes, so the grid is already at the right place when it
      // is uncovered rather than visibly travelling there afterwards.
      if (grid) scrollGridTo(grid, offsetForDate(table, card.topDate))
      onClose()
    },
    [grid, table, onClose],
  )

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={year ? `Months of ${year}` : 'Years in this library'}
      className="fixed inset-0 z-[60] overflow-y-auto bg-paper/95 backdrop-blur-md"
    >
      <div className="mx-auto max-w-5xl px-4 py-5 md:px-8">
        <div className="mb-5 flex items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            {year && (
              <button
                type="button"
                onClick={() => setYear(null)}
                className="rounded-lg border border-line px-3 py-1.5 text-sm transition hover:bg-sunken"
              >
                All years
              </button>
            )}
            <h2 className="heading-display text-xl">{year ?? 'Years'}</h2>
          </div>

          <button
            type="button"
            ref={closeButton}
            onClick={onClose}
            className="rounded-lg border border-line px-3 py-1.5 text-sm transition hover:bg-sunken"
          >
            Close
          </button>
        </div>

        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5">
          {cards.map((card) => {
            const label = year ? formatMonthKey(card.key) : card.key
            return (
              <button
                key={card.key}
                type="button"
                onClick={() => (year ? goToMonth(card) : setYear(card.key))}
                aria-label={
                  year
                    ? `Go to ${label} ${year}, ${card.count} photos`
                    : `Show the months of ${label}, ${card.count} photos`
                }
                className="group text-left"
              >
                <div className="relative aspect-square overflow-hidden rounded-[--radius-tile] bg-sunken">
                  {card.coverAssetId ? (
                    <img
                      src={url(card.coverAssetId, 'thumbnail')}
                      alt=""
                      loading="lazy"
                      decoding="async"
                      className="h-full w-full object-cover transition group-hover:opacity-85"
                    />
                  ) : (
                    /*
                     * Every photograph in this period is still being processed — during an
                     * import, that is most of the recent ones. The count is what is known
                     * about it, so the count is what it shows.
                     */
                    <span className="absolute inset-0 grid place-items-center text-2xl text-muted">
                      {card.count}
                    </span>
                  )}
                </div>
                <span className="mt-1.5 block truncate text-sm">{label}</span>
                <span className="label-micro block text-muted">
                  {card.count} {card.count === 1 ? 'photo' : 'photos'}
                </span>
              </button>
            )
          })}
        </div>
      </div>
    </div>
  )
}
