import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from 'bun:test'
import { render, startDom, stopDom } from '../../test/dom.ts'

beforeAll(() => startDom())
afterAll(async () => {
  await stopDom()
})

/**
 * The panel has to distinguish "still loading" from "cannot ask".
 *
 * In #71 the server's connection pool wedged and `GET /api/v1/admin/queue` stopped
 * answering at all. `AdminProcessing` rendered `isPending || !data` as a skeleton, so the
 * one screen whose job is to report the health of the queue reported a pulsing grey box
 * for 25 hours — identical to a slow page, and no help whatsoever to the person looking
 * at it while nothing was being processed.
 *
 * A failure has to say so, and has to offer a way to ask again.
 */
let answer: () => Promise<unknown> = () =>
  Promise.reject(new Error('Database query timed out after 45000ms'))
const queue = mock(() => answer())

const HEALTHY = {
  queued: 0,
  running: 0,
  failed: 0,
  stuck: 0,
  oldestQueuedAt: null,
  failures: [],
}

/** The repair list and the POST that starts one, both through the SDK's own HTTP client. */
const REPAIRS = {
  items: [
    {
      name: 'captureTime',
      title: 'Capture times stored without their EXIF offset',
      description: 'Re-reads each photograph.',
      candidates: 21802,
      state: 'idle' as const,
    },
  ],
}
const started: string[] = []
/** What `GET /api/v1/admin/repairs` does next. Swapped per test, like `answer` above. */
let repairsAnswer: () => Promise<unknown> = () => Promise.resolve(REPAIRS)
const httpRequest = mock((method: string, path: string) => {
  if (method === 'GET') return repairsAnswer()
  started.push(path)
  return Promise.resolve(undefined)
})

mock.module('../../lib/client.ts', () => ({
  imogen: {
    admin: {
      queue,
      retryAllJobs: () => Promise.resolve(null),
      retryJob: () => Promise.resolve(null),
      discardJob: () => Promise.resolve(null),
    },
    http: { request: httpRequest },
  },
}))
/**
 * Both stubs go back to their defaults between tests.
 *
 * They were restored on each test's last line, which is the line that does not run when
 * an assertion above it throws — so one failure used to leak into every test after it and
 * arrive as a different, more confusing failure.
 */
afterEach(() => {
  answer = () => Promise.reject(new Error('Database query timed out after 45000ms'))
  repairsAnswer = () => Promise.resolve(REPAIRS)
})

/** The client behind the panel most recently rendered, for a test that drives a refetch. */
let panelClient: import('@tanstack/react-query').QueryClient | undefined

async function renderPanel() {
  const { act } = await import('react')
  const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query')
  const { AdminProcessing } = await import('./AdminProcessing.tsx')

  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
  panelClient = client
  const container = await render(
    <QueryClientProvider client={client}>
      <AdminProcessing />
    </QueryClientProvider>,
  )
  // react-query settles the rejection a tick after the first paint.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 50))
  })
  return container
}

describe('the processing panel when the queue cannot be read', () => {
  test('says the queue could not be read rather than pulsing for ever', async () => {
    const container = await renderPanel()

    const text = container.textContent ?? ''
    expect(text).toMatch(/could not be read/i)
    expect(container.querySelector('.animate-pulse')).toBeNull()
  })

  test('shows the reason, so the failure can be acted on', async () => {
    const container = await renderPanel()

    expect(container.textContent ?? '').toMatch(/timed out/i)
  })

  test('offers a way to ask again', async () => {
    const container = await renderPanel()

    const labels = [...container.querySelectorAll('button')].map((b) => b.textContent)
    expect(labels.join(' ')).toMatch(/try again/i)
  })
})

describe('the processing panel once the queue can be read again', () => {
  test('recovers when asked again, rather than staying broken until a reload', async () => {
    answer = () => Promise.reject(new Error('Database query timed out after 45000ms'))
    const container = await renderPanel()
    expect(container.textContent ?? '').toMatch(/could not be read/i)

    const { act } = await import('react')
    answer = () => Promise.resolve(HEALTHY)
    const button = [...container.querySelectorAll('button')].find((b) =>
      /try again/i.test(b.textContent ?? ''),
    )
    await act(async () => {
      button?.click()
      await new Promise((resolve) => setTimeout(resolve, 50))
    })

    const text = container.textContent ?? ''
    expect(text).toMatch(/nothing is waiting/i)
    expect(text).not.toMatch(/could not be read/i)
  })
})

/**
 * A repair rewrites stored values across every account with no undo. The panel's whole
 * reason for existing is that nobody's photographs move because a server was upgraded, so
 * "rendering the list starts nothing" is the assertion that matters here.
 */

/**
 * Renders, then waits for the text to turn up.
 *
 * The repairs list settles a query later than the queue above it, and how much later
 * depends on what else the run is doing — a fixed sleep passed on its own and failed in a
 * full suite. Polling asks the question the test actually means.
 */
async function panelShowing(pattern: RegExp): Promise<HTMLElement> {
  const { act } = await import('react')
  const container = await renderPanel()

  const deadline = Date.now() + 2000
  while (!pattern.test(container.textContent ?? '') && Date.now() < deadline) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10))
    })
  }
  return container
}

describe('the repairs offered in the processing panel', () => {
  test('shows what a pass would open, and starts nothing by rendering', async () => {
    answer = () => Promise.resolve(HEALTHY)
    const container = await panelShowing(/to examine/)

    expect(container.textContent ?? '').toMatch(/21,802 to examine/)
    expect(started).toEqual([])
  })

  test('starts one only when the button is pressed', async () => {
    answer = () => Promise.resolve(HEALTHY)
    const { act } = await import('react')
    const container = await panelShowing(/to examine/)

    const button = [...container.querySelectorAll('button')].find(
      (b) => (b.textContent ?? '').trim() === 'Start',
    )
    expect(button).toBeDefined()
    await act(async () => {
      button?.click()
      await new Promise((resolve) => setTimeout(resolve, 50))
    })

    expect(started).toEqual(['/api/v1/admin/repairs/captureTime'])
  })
})

/**
 * One failed poll must not take the section away.
 *
 * `retry: false` is right here for the same reason it is right above — a pool that cannot
 * give a connection takes the full backstop to fail, and three of those in series would
 * keep the panel silent for minutes. What made it a dead end was the refetch interval,
 * which read `data` to decide whether to keep asking: after an error `data` is undefined,
 * so the interval was `false`, nothing ever asked again, and the section rendered nothing
 * at all — no error, no button, no repairs (#89). An administrator saw the controls
 * simply vanish while a pass might still have been walking the library.
 */
describe('the repairs list when it cannot be read', () => {
  test('says so rather than taking the section away', async () => {
    answer = () => Promise.resolve(HEALTHY)
    repairsAnswer = () => Promise.reject(new Error('Database query timed out after 45000ms'))

    const container = await panelShowing(/repairs could not be read/i)

    expect(container.textContent ?? '').toMatch(/repairs could not be read/i)
    expect(container.textContent ?? '').toMatch(/timed out/i)
  })

  test('offers a way to ask again, and comes back when it works', async () => {
    const { act } = await import('react')
    answer = () => Promise.resolve(HEALTHY)
    repairsAnswer = () => Promise.reject(new Error('Database query timed out after 45000ms'))

    const container = await panelShowing(/repairs could not be read/i)
    const button = [...container.querySelectorAll('button')].find((b) =>
      /try again/i.test(b.textContent ?? ''),
    )
    expect(button).toBeDefined()

    repairsAnswer = () => Promise.resolve(REPAIRS)
    await act(async () => {
      button?.click()
      await new Promise((resolve) => setTimeout(resolve, 50))
    })

    const text = container.textContent ?? ''
    expect(text).toMatch(/21,802 to examine/)
    expect(text).not.toMatch(/repairs could not be read/i)
  })

  /**
   * The interval is the half of #89 no rendering assertion can see: the panel could show
   * an error and still never ask again. It has to go on asking on its own, because the
   * administrator who has walked away from the tab is exactly the one this panel is for.
   */
  test('keeps asking after a failure instead of giving up', async () => {
    const { repairsPollInterval } = await import('./AdminProcessing.tsx')

    expect(
      repairsPollInterval({ status: 'error', data: undefined, error: new Error('a 500') }),
    ).toBeGreaterThan(0)
  })

  /** A server too old to know the route is not a failure, and asking again cannot help. */
  test('stays quiet about a server that has no repairs route', async () => {
    const { ImogenError } = await import('@imogen/sdk')
    const { repairsPollInterval } = await import('./AdminProcessing.tsx')
    const absent = new ImogenError(404, 'not_found', 'Not Found')

    expect(repairsPollInterval({ status: 'error', data: undefined, error: absent })).toBe(false)

    const { act } = await import('react')
    answer = () => Promise.resolve(HEALTHY)
    let refused = 0
    repairsAnswer = () => {
      refused += 1
      return Promise.reject(absent)
    }
    const container = await panelShowing(/nothing is waiting/i)
    // The queue settles first, so wait for the 404 to have actually been answered before
    // asserting on its absence — otherwise this passes whatever the panel does with it.
    const deadline = Date.now() + 2000
    while (refused === 0 && Date.now() < deadline) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 10))
      })
    }
    expect(refused).toBeGreaterThan(0)

    expect(container.textContent ?? '').not.toMatch(/repairs could not be read/i)
    expect(container.textContent ?? '').not.toMatch(/Repairs/)
  })
})

/**
 * A failed poll must not take away what the panel already knows.
 *
 * React Query keeps the last good `data` through an error, and this only polls while a
 * pass is walking — so treating any error as "nothing to show" would swap the live list,
 * the "Walking the library" row and the Start buttons for a red box every time one poll
 * in the fifteen-second cadence blipped, and swap them back on the next. The failure is
 * news; the list is not stale enough to be worth hiding.
 */
describe('the repairs list when a later poll fails', () => {
  test('keeps the list it already has, and says the reading failed above it', async () => {
    const { act } = await import('react')
    answer = () => Promise.resolve(HEALTHY)
    repairsAnswer = () => Promise.resolve(REPAIRS)
    const container = await panelShowing(/to examine/)

    repairsAnswer = () => Promise.reject(new Error('Database query timed out after 45000ms'))
    await act(async () => {
      await panelClient?.refetchQueries({ queryKey: ['admin', 'repairs'] })
      await new Promise((resolve) => setTimeout(resolve, 50))
    })

    const text = container.textContent ?? ''
    expect(text).toMatch(/repairs could not be read/i)
    expect(text).toMatch(/21,802 to examine/)
  })
})
