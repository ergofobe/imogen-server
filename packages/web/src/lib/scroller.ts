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

/**
 * Puts the reader at a position in *grid* coordinates — the coordinates the segment table
 * speaks — rather than in the scroller's.
 *
 * Clamped here rather than left to the browser. A browser silently clamps an out-of-range
 * assignment, so a rail dragged to the very bottom would read back somewhere other than
 * where it wrote and jitter against its own thumb for the rest of the drag.
 */
export function scrollGridTo(container: HTMLElement, gridTop: number): void {
  const scroller = scrollingAncestorOf(container)
  const target = gridOffsetWithin(container, scroller) + gridTop
  const limit = Math.max(0, scroller.scrollHeight - scroller.clientHeight)
  scroller.scrollTop = Math.min(limit, Math.max(0, target))
}

/** Where the reader is, in grid coordinates. The inverse of `scrollGridTo`. */
export function gridTopOf(container: HTMLElement): number {
  const scroller = scrollingAncestorOf(container)
  return scroller.scrollTop - gridOffsetWithin(container, scroller)
}

/**
 * The thing that reports this scroller's scrolling. The document is the scroller on every
 * page in this app today, and it fires `scroll` at `window` rather than at the element.
 */
export function scrollEventSourceFor(scroller: Element): EventTarget {
  return scroller === document.scrollingElement ? window : scroller
}
