import { afterAll, beforeAll, expect, test } from 'bun:test'
import type { TimelineBucket, TimelineTile } from '@imogen/shared'
import { useEffect } from 'react'
import { render, startDom, stopDom } from '../test/dom.ts'

/**
 * The one thing about `useTimeline` that arithmetic cannot answer: whether the loop it
 * closes over settles.
 *
 * `periodsToFetch` asks for the months on screen and one either side; eviction decides which
 * months are kept. While those were two different sets they could disagree — more months on
 * screen than the budget allowed, which a sparse library on a tall viewport reaches easily —
 * and then a neighbour was evicted the instant it landed, `loaded.periods` changed identity,
 * the fetch effect re-ran, found the month missing and asked again. One round trip per lap,
 * for as long as the reader sat still.
 *
 * So this counts requests rather than watching for one, and the assertion that matters is
 * that the number stops going up. Everything above it is fixture.
 */

beforeAll(startDom)
afterAll(stopDom)

const OPTIONS = { width: 1200, targetHeight: 208, gap: 4, sectionGap: 44, headerHeight: 40 }

/** Fourteen consecutive months, newest first, the way the spine lists them. */
const ALL_PERIODS = Array.from({ length: 14 }, (_, back) => {
  const month = 12 - (back % 12)
  const year = 2012 - Math.floor(back / 12)
  return `${year}-${String(month).padStart(2, '0')}`
})

/**
 * Ten of them on screen at once, none of them at the ends of the library so the fetch set
 * really is twelve. A few photographs a month on a tall viewport is an ordinary library, and
 * ten is comfortably past `MAX_LOADED_PERIODS`.
 */
const VISIBLE = ALL_PERIODS.slice(2, 12)

const BUCKETS: TimelineBucket[] = ALL_PERIODS.map((period) => ({
  date: `${period}-15`,
  count: 1,
  coverAssetId: null,
}))

function tileFor(period: string): TimelineTile {
  return {
    id: `tile-${period}`,
    capturedAt: `${period}-15T12:00:00.000Z`,
    width: 4000,
    height: 3000,
    type: 'image',
    status: 'ready',
    favorite: false,
    duration: null,
    placeholderColor: null,
    livePhotoVideoId: null,
  }
}

/**
 * Well past the twelve months this view can ask for, and far short of forever. Beyond it the
 * fixture stops answering rather than throwing: a runaway loop then stalls instead of
 * hanging `act`, and the count it got to is what the failure reports.
 */
const CEILING = 100

test('a viewport holding more months than the budget stops fetching once they have landed', async () => {
  const asked: string[] = []
  const source = {
    key: 'sparse-library',
    timeline: async () => ({ buckets: BUCKETS }),
    bucket: async (query: { period: string }) => {
      asked.push(query.period)
      if (asked.length > CEILING) {
        return new Promise<{ items: TimelineTile[]; nextCursor: string | null }>(() => {})
      }
      return { items: [tileFor(query.period)], nextCursor: null }
    },
  }

  // Imported here rather than at the top of the file: the hook reaches the SDK client, and
  // the client reads `window` the moment it is evaluated.
  const { useTimeline, MAX_LOADED_PERIODS } = await import('./useTimeline.ts')
  const { QueryClient, QueryClientProvider, notifyManager } = await import('@tanstack/react-query')
  const { act } = await import('react')

  /*
   * React Query hands its subscribers their updates through a `setTimeout(…, 0)`. Whether
   * that timer fires inside `act` depends on which happy-dom window is currently registered
   * — the harness registers and unregisters one per file — so in a full run the spine's
   * answer landed after the assertions rather than before them, and this test measured a
   * library that had not arrived yet. Notifying synchronously takes the timer out of it.
   */
  notifyManager.setScheduler((notify) => notify())

  function Harness() {
    const { requestPeriods } = useTimeline({}, OPTIONS, { source })
    useEffect(() => requestPeriods(VISIBLE), [requestPeriods])
    return null
  }

  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
  await render(
    <QueryClientProvider client={client}>
      <Harness />
    </QueryClientProvider>,
  )

  const settle = async (rounds: number) => {
    for (let round = 0; round < rounds; round++) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0))
      })
    }
  }

  await settle(10)

  // Ten visible months plus one either side, each asked for exactly once. The fixture never
  // fails, so a second request for a month is a month that was thrown away and wanted back.
  expect(VISIBLE.length).toBeGreaterThan(MAX_LOADED_PERIODS)
  expect(new Set(asked).size).toBe(VISIBLE.length + 2)
  expect(asked).toHaveLength(VISIBLE.length + 2)

  // And it is a steady state rather than a slow lap: ten more rounds add nothing at all.
  const settled = asked.length
  await settle(10)
  expect(asked).toHaveLength(settled)

  client.clear()
  // Global, so it goes back the way it was found rather than leaking into the next file.
  notifyManager.setScheduler((notify) => setTimeout(notify, 0))
})
