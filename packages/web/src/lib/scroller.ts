/**
 * Which element actually scrolls a grid, and where the grid sits inside it.
 *
 * Extracted from `PhotoGrid` because the rail and the overview both write the scroll
 * position that the grid reads. Two copies of this arithmetic would be two chances to
 * disagree about the coordinate space, and a rail that is a page header's worth out is
 * a rail that lands on the wrong day at one end of the timeline and the right one at
 * the other — the hardest kind of wrong to notice.
 */

/**
 * The element that actually scrolls this grid. Today that is always the document, but
 * finding it rather than assuming it means a grid dropped inside a panel or a dialog
 * measures the thing it is really inside.
 */
export function scrollingAncestorOf(element: HTMLElement): Element {
  for (let node = element.parentElement; node; node = node.parentElement) {
    const overflow = getComputedStyle(node).overflowY
    if (overflow === 'auto' || overflow === 'scroll') return node
  }
  return document.scrollingElement ?? document.documentElement
}

/** Where the grid's own top sits in the scroller's content, page furniture included. */
export function gridOffsetWithin(container: HTMLElement, scroller: Element): number {
  const scrollerTop =
    scroller === document.scrollingElement ? 0 : scroller.getBoundingClientRect().top
  return container.getBoundingClientRect().top - scrollerTop + scroller.scrollTop
}

/** As much of a scroller as the arithmetic below needs, so it can be given a stub. */
export type ScrollerMetrics = { scrollTop: number; scrollHeight: number; clientHeight: number }

/**
 * Where `scrollTop` has to go to bring grid position `gridTop` to the top of the viewport.
 *
 * Clamped here rather than left to the browser. A browser silently clamps an out-of-range
 * assignment, so a rail dragged to the very bottom would read back somewhere other than
 * where it wrote and jitter against its own thumb for the rest of the drag. Separated from
 * the element it will be written to because a clamp is exactly the kind of thing that is
 * right in the middle and wrong at both ends, and this way both ends can be tested.
 */
export function scrollTargetFor(
  metrics: Omit<ScrollerMetrics, 'scrollTop'>,
  gridOffset: number,
  gridTop: number,
): number {
  const limit = Math.max(0, metrics.scrollHeight - metrics.clientHeight)
  return Math.min(limit, Math.max(0, gridOffset + gridTop))
}

/** Where the reader is, in grid coordinates. The inverse, and unclamped: it is a reading. */
export function gridTopFrom(scrollTop: number, gridOffset: number): number {
  return scrollTop - gridOffset
}

/**
 * Puts the reader at a position in *grid* coordinates — the coordinates the segment table
 * speaks — rather than in the scroller's.
 */
export function scrollGridTo(container: HTMLElement, gridTop: number): void {
  const scroller = scrollingAncestorOf(container)
  scroller.scrollTop = scrollTargetFor(scroller, gridOffsetWithin(container, scroller), gridTop)
}

/**
 * How much of the scroller is on screen.
 *
 * The rail needs it because the last screenful is never scrolled past: a thumb measured
 * against the library's whole height stops short of the bottom by exactly this much.
 */
export function viewportHeightOf(container: HTMLElement): number {
  return scrollingAncestorOf(container).clientHeight
}

/** Where the reader is, in grid coordinates. The inverse of `scrollGridTo`. */
export function gridTopOf(container: HTMLElement): number {
  const scroller = scrollingAncestorOf(container)
  return gridTopFrom(scroller.scrollTop, gridOffsetWithin(container, scroller))
}

/**
 * The thing that reports this scroller's scrolling. The document is the scroller on every
 * page in this app today, and it fires `scroll` at `window` rather than at the element.
 */
export function scrollEventSourceFor(scroller: Element): EventTarget {
  return scroller === document.scrollingElement ? window : scroller
}
