import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test'
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
const httpRequest = mock((method: string, path: string) => {
  if (method === 'GET') return Promise.resolve(REPAIRS)
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

async function renderPanel() {
  const { act } = await import('react')
  const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query')
  const { AdminProcessing } = await import('./AdminProcessing.tsx')

  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
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

    answer = () => Promise.reject(new Error('Database query timed out after 45000ms'))
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
    answer = () => Promise.reject(new Error('Database query timed out after 45000ms'))
  })
})
