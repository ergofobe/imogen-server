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

export function startDom(): void {
  if (registered) return
  GlobalRegistrator.register()
  registered = true

  // happy-dom does not implement it, and a component that measures itself constructs one
  // in a layout effect. A stub that never fires is the honest default: it puts the
  // component in exactly the state this harness exists to inspect — mounted, unmeasured.
  if (!('ResizeObserver' in globalThis)) {
    ;(globalThis as Record<string, unknown>).ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
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
