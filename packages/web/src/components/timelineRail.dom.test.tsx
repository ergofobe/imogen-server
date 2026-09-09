import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { buildSegments } from '../lib/timelineLayout.ts'
import { measureAs, render, startDom, stopDom } from '../test/dom.ts'
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

/**
 * The rail is fixed over the right edge of the grid, and the grid slides under it. So
 * whatever in the strip answers to a pointer is a strip of photographs that cannot be
 * clicked — a third of the last column on a phone.
 *
 * happy-dom lays nothing out and hit-tests nothing, so it cannot say where a click on the
 * screen would land. What it can say is where the handlers are: a pointer put down on the
 * strip itself must start nothing, and only the one element inside it that answers to a
 * pointer may take hold.
 */
describe('TimelineRail once it has a height', () => {
  beforeAll(() => measureAs({ width: 44, height: 800 }))
  afterAll(() => measureAs(null))

  const pointerDown = (target: Element) =>
    target.dispatchEvent(
      new PointerEvent('pointerdown', { bubbles: true, pointerId: 1, button: 0, clientY: 400 }),
    )

  test('the strip itself takes no pointer; only the thumb does', async () => {
    const { act } = await import('react')
    const suspended: boolean[] = []
    const container = await render(
      <TimelineRail table={library()} grid={null} suspendFetching={(on) => suspended.push(on)} />,
    )
    const slider = container.querySelector('[role="slider"]')
    expect(slider).not.toBeNull()
    if (!slider) return

    // The CSS that lets a click fall through to the photograph beneath, asserted by name
    // because nothing here can click.
    expect(slider.className).toContain('pointer-events-none')

    await act(async () => {
      pointerDown(slider)
    })
    expect(suspended).toEqual([])

    const thumb = slider.querySelector('.pointer-events-auto')
    expect(thumb).not.toBeNull()
    if (!thumb) return
    await act(async () => {
      pointerDown(thumb)
    })
    expect(suspended).toEqual([true])
  })
})
