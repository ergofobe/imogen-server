import { useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { LayoutOptions } from '../lib/timelineLayout.ts'

/**
 * The grid's own measurements, worked out from the element it will actually draw into.
 *
 * They live outside `PhotoGrid` because the geometry module needs them before there is
 * anything to draw: `useTimeline` sizes seven thousand days from `LayoutOptions` alone,
 * and a route cannot ask the grid for a width the grid has not been given data to have.
 */

export const GAP = 4
export const SECTION_GAP = 44

/**
 * The sticky day heading, as one string used twice: once by the real header and once by
 * the probe that measures it. Two copies of these classes would be two chances for the
 * measured height and the drawn height to disagree, and the geometry module counts this
 * height once per day — a pixel of drift is a pixel per day of accumulated error.
 */
export const DAY_HEADER_CLASS =
  'sticky top-0 z-10 -mx-4 mb-2.5 bg-paper/85 px-4 py-2 backdrop-blur-md'
export const DAY_HEADING_CLASS = 'heading-display text-[15px]'

/**
 * What the classes above come to when they are laid out: 8px of padding either side of a
 * 15px display heading at a line height of 1.05, plus a 10px margin under the whole thing.
 * Only ever used before the probe has run — the real value is measured, not assumed.
 */
const DERIVED_HEADER_HEIGHT = 8 + 15 * 1.05 + 8 + 10

/** Row height scales with the viewport: a phone wants fewer, larger photos per row. */
export function targetHeightFor(width: number): number {
  if (width < 480) return 132
  if (width < 900) return 168
  if (width < 1600) return 208
  return 240
}

export type GridLayout = {
  /** Attach to the element the grid draws into; everything else is measured from it. */
  containerRef: React.RefObject<HTMLDivElement | null>
  options: LayoutOptions
}

export function useGridLayout(): GridLayout {
  const containerRef = useRef<HTMLDivElement>(null)
  const [metrics, setMetrics] = useState({ width: 0, headerHeight: DERIVED_HEADER_HEIGHT })

  useLayoutEffect(() => {
    const container = containerRef.current
    if (!container) return

    // The observer fires on height too, and the grid's height changes every time a day
    // resolves. Only a change of width can change the layout, so the rest is dropped
    // before it can cost a forced reflow for the header probe.
    let lastWidth = -1
    const observer = new ResizeObserver(([entry]) => {
      const width = entry?.contentRect.width ?? 0
      if (width === lastWidth) return
      lastWidth = width
      const headerHeight = measureDayHeaderHeight(container)
      setMetrics((current) =>
        current.width === width && current.headerHeight === headerHeight
          ? current
          : { width, headerHeight },
      )
    })
    observer.observe(container)
    return () => observer.disconnect()
  }, [])

  const options = useMemo<LayoutOptions>(
    () => ({
      width: metrics.width,
      targetHeight: targetHeightFor(metrics.width),
      gap: GAP,
      sectionGap: SECTION_GAP,
      headerHeight: metrics.headerHeight,
    }),
    [metrics],
  )

  return { containerRef, options }
}

/**
 * The real height of a day heading, including the margin that separates it from the
 * photographs, taken by laying one out and reading it back.
 *
 * A literal would be a guess about type metrics, and the geometry module charges this
 * height to every one of the seven thousand days a twenty-year library holds: half a
 * pixel of error there is a heading landing in the wrong place by the end of the scroll.
 * The probe is hidden and taken out of flow, so it measures without being seen and
 * without moving anything.
 */
function measureDayHeaderHeight(container: HTMLElement): number {
  const probe = container.ownerDocument.createElement('header')
  probe.className = DAY_HEADER_CLASS
  probe.setAttribute('aria-hidden', 'true')
  probe.style.position = 'absolute'
  probe.style.visibility = 'hidden'
  probe.style.pointerEvents = 'none'
  probe.style.top = '0'
  probe.style.left = '0'
  probe.style.width = '100%'

  const heading = container.ownerDocument.createElement('h2')
  heading.className = DAY_HEADING_CLASS
  // Ascenders and descenders both, so a line box measures at its full height.
  heading.textContent = 'Thursday, 14 July 2011'
  probe.append(heading)

  container.append(probe)
  const height = probe.getBoundingClientRect().height
  const marginBottom = Number.parseFloat(getComputedStyle(probe).marginBottom) || 0
  probe.remove()

  // A container detached from layout — a hidden route, a print stylesheet — measures
  // nothing at all, and a zero here would collapse every day by the header's worth.
  return height > 0 ? height + marginBottom : DERIVED_HEADER_HEIGHT
}
