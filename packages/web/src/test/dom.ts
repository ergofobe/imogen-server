import { GlobalRegistrator } from '@happy-dom/global-registrator'
import type { ReactElement } from 'react'

/**
 * Just enough DOM to render a component and look at what came out.
 *
 * This exists because of a defect class that has now escaped a green suite three times in
 * this phase: a component that renders nothing at all. The grid rendered nothing on a cold
 * load, and the rail rendered nothing because it refused to render until it had been
 * measured — and its height came from observing itself, so it was never measured. Both
 * were found by standing the whole application up against a real database, which is an
 * expensive way to learn that a component returned null.
 *
 * Deliberately small. It is not a testing library and the existing suite is not being
 * converted to use it: almost everything here is pure and is better tested as arithmetic.
 * What a DOM buys is the one question arithmetic cannot answer — did anything render.
 *
 * Registration is global and process-wide, so it is turned on and off around the tests
 * that want it rather than preloaded for the whole run.
 */

let registered = false
let measured: { width: number; height: number } | null = null

/**
 * Makes every observed element report this size, for a test whose subject cannot render
 * until it has been measured. Set it before rendering; clear it with `null` afterwards so
 * the next file gets the unmeasured default back.
 */
export function measureAs(size: { width: number; height: number } | null): void {
  measured = size
}

export function startDom(): void {
  if (registered) return
  GlobalRegistrator.register()
  registered = true
  ;(globalThis as Record<string, unknown>).ResizeObserver = class {
    constructor(private readonly report: (entries: unknown[]) => void) {}
    observe(target: Element) {
      if (!measured) return
      // Asynchronously, as a real observer reports: synchronously inside `observe` would
      // set state during the layout effect that created it.
      queueMicrotask(() => this.report([{ target, contentRect: measured }]))
    }
    unobserve() {}
    disconnect() {}
  }
  /*
   * happy-dom lays nothing out, so every element is zero by zero. A windowed grid asks its
   * scroller how tall the viewport is and draws the days inside it — against a zero it
   * draws an empty band, decides no month is on screen, and fetches nothing. So the same
   * `measureAs` size answers here too, and the unmeasured default stays zero.
   */
  // Both prototypes: happy-dom defines these on `HTMLElement`, which would shadow an
  // override placed only on `Element` — and `document.scrollingElement`, the one whose
  // height decides how much of the grid is on screen, is an `HTMLElement`.
  for (const prototype of [Element.prototype, HTMLElement.prototype]) {
    for (const [property, side] of [
      ['clientWidth', 'width'],
      ['offsetWidth', 'width'],
      ['clientHeight', 'height'],
      ['offsetHeight', 'height'],
    ] as const) {
      Object.defineProperty(prototype, property, {
        configurable: true,
        get: () => measured?.[side] ?? 0,
      })
    }
  }

  ;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true
}

export async function stopDom(): Promise<void> {
  if (!registered) return
  registered = false
  await GlobalRegistrator.unregister()
}

/**
 * Renders into a detached container and hands it back.
 *
 * React and react-dom are imported here rather than at the top of the file so that they
 * are first evaluated after `startDom` has put a document in place.
 */
export async function render(element: ReactElement): Promise<HTMLElement> {
  const { act } = await import('react')
  const { createRoot } = await import('react-dom/client')

  const container = document.createElement('div')
  document.body.append(container)
  await act(async () => {
    createRoot(container).render(element)
  })
  return container
}
