import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { buildSegments } from '../lib/timelineLayout.ts'
import { render, startDom, stopDom } from '../test/dom.ts'
import { TimelineRail } from './TimelineRail.tsx'

beforeAll(startDom)
afterAll(stopDom)

const OPTIONS = { width: 1200, targetHeight: 208, gap: 4, sectionGap: 44, headerHeight: 40 }

const library = () =>
  buildSegments(
    Array.from({ length: 24 }, (_, i) => ({
      date: `2012-${String(12 - (i % 12)).padStart(2, '0')}-${String(28 - i).padStart(2, '0')}`,
      count: 400,
      coverAssetId: null,
    })),
    new Map(),
    OPTIONS,
    new Map(),
  )

/**
 * The one test that pins the defect class this harness was added for.
 *
 * The rail's height comes from a `ResizeObserver` on the rail itself. An earlier version
 * returned `null` until it had a height — so there was no element to observe, so it never
 * got a height, so it never rendered. A blank that feeds itself, on a real library, with
 * every other test in this repo green. The whole suite could not see it because the whole
 * suite tests arithmetic, and the arithmetic was right.
 *
 * The stubbed observer never fires, which puts the component in exactly the state that
 * regression lived in: mounted, and not yet measured.
 */
describe('TimelineRail before anything has measured it', () => {
  test('puts its measurable shell in the document rather than waiting to be measured', async () => {
    const container = await render(
      <TimelineRail table={library()} grid={null} suspendFetching={() => {}} />,
    )

    const shell = container.firstElementChild
    expect(shell).not.toBeNull()
    // Fixed to the viewport, so it has a height for the observer to report the moment it
    // is attached — one that owes nothing to whether there is anything drawn inside it.
    expect(shell?.className).toContain('fixed')
  })

  test('offers nothing to interact with until it knows how tall it is', async () => {
    const container = await render(
      <TimelineRail table={library()} grid={null} suspendFetching={() => {}} />,
    )

    // The shell is present; the slider inside it is not, because an unmeasured rail cannot
    // map a pointer to a date yet. Shell always, contents conditional — that is the rule,
    // and reversing the two is the bug.
    expect(container.querySelector('[role="slider"]')).toBeNull()
    expect(container.firstElementChild).not.toBeNull()
  })

  test('an empty library still renders a shell, and still offers no slider', async () => {
    const empty = buildSegments([], new Map(), OPTIONS, new Map())
    const container = await render(
      <TimelineRail table={empty} grid={null} suspendFetching={() => {}} />,
    )

    expect(container.firstElementChild).not.toBeNull()
    expect(container.querySelector('[role="slider"]')).toBeNull()
  })
})
