import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import type { TimelineGrid } from '../hooks/useTimelineGrid.ts'
import { buildSegments } from '../lib/timelineLayout.ts'
import { measureAs, render, startDom, stopDom } from '../test/dom.ts'

/**
 * Imported inside the tests rather than at the top of the file. The component reaches the
 * SDK client through the overview, and the client reads `window` the moment it is
 * evaluated — so a static import here would run before `startDom` has put a document in
 * place, exactly as `render` already has to do for React itself.
 */
const load = async () => (await import('./TimelineBody.tsx')).TimelineBody

beforeAll(() => {
  startDom()
  measureAs({ width: 1200, height: 800 })
})
afterAll(async () => {
  measureAs(null)
  await stopDom()
})

const OPTIONS = { width: 1200, targetHeight: 208, gap: 4, sectionGap: 44, headerHeight: 40 }

const EMPTY = {
  headline: 'This album is empty',
  body: 'Select photos in your timeline and add them here.',
}

/**
 * The two states that both look like zero.
 *
 * `totalCount` is 0 while the spine is in the air and 0 when the spine says there is
 * nothing — and for a while every route that gated its own skeleton on a smaller metadata
 * query got the first one wrong. The metadata landed first, the skeleton stopped, and an
 * album of fifteen hundred photographs announced that it was empty until the spine
 * arrived. On a shared link that was a stranger's first paint of a gift.
 *
 * These assert the decision itself rather than a route's timing, because timing is what
 * made it invisible: the route tests settle fifteen ticks before looking, so a transient
 * wrong state cannot be seen from there by construction.
 */
function grid(overrides: Partial<TimelineGrid>): TimelineGrid {
  return {
    table: buildSegments([], new Map(), OPTIONS, new Map()),
    tiles: new Map(),
    isPending: false,
    totalCount: 0,
    options: OPTIONS,
    attachGrid: () => {},
    grid: null,
    ordered: [],
    ids: [],
    requestPeriods: () => {},
    suspendFetching: () => {},
    reload: () => {},
    onVisibleRangeChange: () => {},
    showingOverview: false,
    setShowingOverview: () => {},
    requestNeighbour: () => null,
    ...overrides,
  } as TimelineGrid
}

describe('TimelineBody while the spine is still in the air', () => {
  test('does not tell anybody their photographs do not exist', async () => {
    const TimelineBody = await load()
    const container = await render(
      <TimelineBody
        grid={grid({ isPending: true, totalCount: 0 })}
        filter={{}}
        empty={EMPTY}
        onOpen={() => {}}
      />,
    )

    expect(container.textContent).not.toContain(EMPTY.headline)
    expect(container.textContent).not.toContain(EMPTY.body)
    // A skeleton, which says "not yet" rather than "never".
    expect(container.querySelector('.animate-pulse')).not.toBeNull()
  })

  test('says it is empty once the spine has actually answered', async () => {
    const TimelineBody = await load()
    const container = await render(
      <TimelineBody
        grid={grid({ isPending: false, totalCount: 0 })}
        filter={{}}
        empty={EMPTY}
        onOpen={() => {}}
      />,
    )

    expect(container.textContent).toContain(EMPTY.headline)
    expect(container.textContent).toContain(EMPTY.body)
  })

  test('draws the grid when the spine has answered with something', async () => {
    const table = buildSegments(
      [{ date: '2019-06-14', count: 3, coverAssetId: null }],
      new Map(),
      OPTIONS,
      new Map(),
    )
    const TimelineBody = await load()
    const container = await render(
      <TimelineBody
        grid={grid({ isPending: false, totalCount: 3, table })}
        filter={{}}
        empty={EMPTY}
        onOpen={() => {}}
      />,
    )

    expect(container.textContent).not.toContain(EMPTY.headline)
    expect(container.querySelector('section')).not.toBeNull()
  })
})
