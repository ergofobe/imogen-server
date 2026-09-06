import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test'
import { measureAs, render, startDom, stopDom } from '../test/dom.ts'

beforeAll(() => {
  startDom()
  measureAs({ width: 1200, height: 800 })
})
afterAll(async () => {
  measureAs(null)
  await stopDom()
})

/**
 * What happens to "Move to vault" when the vault turns out to be locked.
 *
 * The action needs the vault open, so it sends the reader to the unlock screen. The bug
 * this file exists for is what used to happen next: nothing. The passphrase was accepted,
 * the vault opened, and the photographs the reader had selected were still sitting in the
 * library — the request was thrown away at the moment of the navigation, and the reader
 * had to work out for themselves that they were meant to start again.
 *
 * An unlock demanded BY an action has to finish that action.
 */

const PASSPHRASE = 'correct horse battery'

const TILES = [
  { id: 'aaaaaaaa-1111-4111-8111-111111111111', capturedAt: '2019-06-14T10:00:00.000Z' },
  { id: 'bbbbbbbb-2222-4222-8222-222222222222', capturedAt: '2019-06-14T11:00:00.000Z' },
]

type Call = { what: string; body: unknown }
const calls: Call[] = []
const record = (what: string) => (body: unknown) => {
  calls.push({ what, body })
  return Promise.resolve({
    moved: Array.isArray((body as { assetIds?: string[] })?.assetIds) ? 1 : 0,
  })
}

let unlocked = false
let configured = true

const buckets = [{ date: '2019-06-14', count: TILES.length, coverAssetId: null }]
const spine = (scope: string) => (query: unknown) => {
  calls.push({ what: `${scope}:timeline`, body: query })
  return Promise.resolve({ buckets })
}
const bucketPage = () =>
  Promise.resolve({
    items: TILES.map((t) => ({
      ...t,
      width: 4032,
      height: 3024,
      type: 'image' as const,
      status: 'ready' as const,
      favorite: false,
      duration: null,
      placeholderColor: null,
      livePhotoVideoId: null,
    })),
    nextCursor: null,
    total: TILES.length,
  })

mock.module('../lib/client.ts', () => ({
  imogen: {
    assets: {
      timeline: spine('library'),
      timelineBucket: bucketPage,
      stats: () => Promise.resolve({ assetCount: TILES.length }),
      trash: record('assets.trash'),
      restore: record('assets.restore'),
      get: () => Promise.resolve(null),
      update: () => Promise.resolve(null),
    },
    vault: {
      status: () => {
        calls.push({ what: 'vault.status', body: null })
        return Promise.resolve({ configured, unlocked })
      },
      setPassphrase: (passphrase: string) => {
        calls.push({ what: 'vault.setPassphrase', body: passphrase })
        configured = true
        return Promise.resolve()
      },
      unlock: (passphrase: string) => {
        calls.push({ what: 'vault.unlock', body: passphrase })
        if (passphrase !== PASSPHRASE) return Promise.reject(new Error('That passphrase is wrong'))
        unlocked = true
        return Promise.resolve()
      },
      lock: () => Promise.resolve(),
      timeline: spine('vault'),
      timelineBucket: bucketPage,
      moveIn: record('vault.moveIn'),
      moveOut: record('vault.moveOut'),
    },
  },
}))

beforeEach(() => {
  calls.length = 0
  unlocked = false
  configured = true
})

async function settle() {
  const { act } = await import('react')
  for (let i = 0; i < 15; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
  }
}

/** The whole app's shape as far as this bug is concerned: a library and a vault. */
async function mountApp(path = '/') {
  const { MemoryRouter, Route, Routes } = await import('react-router')
  const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query')
  const { Timeline } = await import('./Timeline.tsx')
  const { VaultRoute } = await import('./VaultRoute.tsx')
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: 0, gcTime: 0 } },
  })
  const container = await render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route
            path="/"
            element={<Timeline title="Library" empty={{ headline: 'None', body: 'None' }} />}
          />
          <Route path="/vault" element={<VaultRoute />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  )
  await settle()
  return container
}

async function press(element: Element | null | undefined, what: string) {
  const { act } = await import('react')
  if (!element) throw new Error(`nothing to press for "${what}"`)
  await act(async () => {
    ;(element as HTMLElement).click()
  })
  await settle()
}

const button = (container: ParentNode, text: string) =>
  [...container.querySelectorAll('button')].find((b) => b.textContent?.trim() === text)

/** Types into a controlled input the way a person does, then submits its form. */
async function fillAndSubmit(container: HTMLElement, values: string[]) {
  const { act } = await import('react')
  const inputs = [...container.querySelectorAll('input[type="password"]')] as HTMLInputElement[]
  if (inputs.length < values.length) throw new Error('not enough fields on screen')
  await act(async () => {
    values.forEach((value, index) => {
      const input = inputs[index] as HTMLInputElement
      const setter = Object.getOwnPropertyDescriptor(
        globalThis.HTMLInputElement.prototype,
        'value',
      )?.set
      setter?.call(input, value)
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
  })
  await settle()
  const form = container.querySelector('form')
  if (!form) throw new Error('no form on screen')
  await act(async () => {
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
  })
  await settle()
}

/** Ticks one photograph in the library and asks for it to be moved to the vault. */
async function askToVault(container: HTMLElement) {
  await press(container.querySelector('[aria-label="Select"]'), 'a photograph')
  await press(button(container, 'Move to vault'), 'Move to vault')
}

describe('an unlock the reader was sent to by an action', () => {
  test('finishes the move once the passphrase is accepted', async () => {
    unlocked = false
    const container = await mountApp()
    await askToVault(container)

    expect(container.textContent).toContain('Vault locked')
    expect(calls.some((c) => c.what === 'vault.moveIn')).toBe(false)

    await fillAndSubmit(container, [PASSPHRASE])

    expect(calls.find((c) => c.what === 'vault.moveIn')?.body).toEqual({
      assetIds: [TILES[0]?.id],
    })
  })

  test('finishes the move after the vault is set up for the first time', async () => {
    configured = false
    unlocked = false
    const container = await mountApp()
    await askToVault(container)

    expect(container.textContent).toContain('Set up your vault')
    await fillAndSubmit(container, [PASSPHRASE, PASSPHRASE])

    expect(calls.find((c) => c.what === 'vault.moveIn')?.body).toEqual({
      assetIds: [TILES[0]?.id],
    })
  })

  test('says what it did, rather than leaving the reader to count', async () => {
    unlocked = false
    const container = await mountApp()
    await askToVault(container)
    await fillAndSubmit(container, [PASSPHRASE])

    expect(container.textContent).toContain('Moved 1 photo to the vault')
  })

  test('a wrong passphrase moves nothing and keeps the request for the next try', async () => {
    unlocked = false
    const container = await mountApp()
    await askToVault(container)

    await fillAndSubmit(container, ['not the passphrase'])
    expect(calls.some((c) => c.what === 'vault.moveIn')).toBe(false)

    await fillAndSubmit(container, [PASSPHRASE])
    expect(calls.find((c) => c.what === 'vault.moveIn')?.body).toEqual({
      assetIds: [TILES[0]?.id],
    })
  })
})

describe('an unlock nobody asked an action of', () => {
  test('opens the vault and moves nothing', async () => {
    unlocked = false
    const container = await mountApp('/vault')

    expect(container.textContent).toContain('Vault locked')
    await fillAndSubmit(container, [PASSPHRASE])

    expect(container.textContent).toContain('Vault')
    expect(calls.some((c) => c.what === 'vault.moveIn')).toBe(false)
  })
})
