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
const queue = mock(() => Promise.reject(new Error('Database query timed out after 45000ms')))

mock.module('../../lib/client.ts', () => ({
  imogen: {
    admin: {
      queue,
      retryAllJobs: () => Promise.resolve(null),
      retryJob: () => Promise.resolve(null),
      discardJob: () => Promise.resolve(null),
    },
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
