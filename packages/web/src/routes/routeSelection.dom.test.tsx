import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test'
import { measureAs, render, startDom, stopDom } from '../test/dom.ts'

beforeAll(() => {
  startDom()
  // A grid takes its column width from a ResizeObserver and nothing else, so a route
  // rendered against the harness's unmeasured default lays out zero-wide and draws no
  // tiles — and a test that cannot click a photograph cannot select all of them.
  measureAs({ width: 1200, height: 800 })
})
afterAll(async () => {
  measureAs(null)
  await stopDom()
})

/**
 * What each route sends when somebody selects everything.
 *
 * This is the worst outcome available anywhere in this feature, and it is silent. A route
 * that passed `{}` to `useSelection` would look correct on screen — the bar would count,
 * the dialog would state a number, the request would succeed — and a select-all inside one
 * album would trash the entire library. Nothing else in the suite can see it: the hook is
 * right, `toRequest` is right, and the defect is a single argument at one call site.
 *
 * So each route is mounted for real and its select-all is carried through to the request
 * body. An album route that sent no `albumId` fails here, loudly.
 *
 * The SDK client is replaced rather than `globalThis.fetch`, because the client binds
 * `fetch` once when it is constructed — patching the global afterwards reaches nothing,
 * which is a thing this project has now learned twice.
 */

const ALBUM_ID = '11111111-1111-4111-8111-111111111111'
const PERSON_ID = '22222222-2222-4222-8222-222222222222'

const TILES = [
  { id: 'aaaaaaaa-1111-4111-8111-111111111111', capturedAt: '2019-06-14T10:00:00.000Z' },
  { id: 'bbbbbbbb-2222-4222-8222-222222222222', capturedAt: '2019-06-14T11:00:00.000Z' },
]

type Call = { what: string; body: unknown }
const calls: Call[] = []
const record = (what: string) => (body: unknown) => {
  calls.push({ what, body })
  return Promise.resolve({ count: 0, moved: 0, removed: 0, added: 0, skipped: 0 })
}

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
    albums: {
      get: () =>
        Promise.resolve({ id: ALBUM_ID, name: 'Corfu', assetCount: 30_000, shareSlug: null }),
      removeAssets: (_albumId: string, body: unknown) => record('albums.removeAssets')(body),
      remove: () => Promise.resolve(),
    },
    people: { get: () => Promise.resolve({ id: PERSON_ID, name: 'Ada', photoCount: 600 }) },
    vault: {
      status: () => Promise.resolve({ configured: true, unlocked: true }),
      timeline: spine('vault'),
      timelineBucket: bucketPage,
      moveOut: record('vault.moveOut'),
      moveIn: record('vault.moveIn'),
      lock: () => Promise.resolve(),
    },
  },
}))

async function mount(path: string, route: string, element: React.ReactElement) {
  calls.length = 0
  const { MemoryRouter, Route, Routes } = await import('react-router')
  const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query')
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: 0, gcTime: 0 } },
  })
  const container = await render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path={route} element={element} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  )
  await settle()
  return container
}

async function settle() {
  const { act } = await import('react')
  for (let i = 0; i < 15; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
  }
}

/** Ticks one photograph, presses Select all, then presses the named action through to send. */
async function selectAllThen(container: HTMLElement, action: string) {
  const { act } = await import('react')
  const press = async (element: Element | null | undefined, what: string) => {
    if (!element) throw new Error(`nothing to press for "${what}"`)
    await act(async () => {
      ;(element as HTMLElement).click()
    })
    await settle()
  }
  const button = (text: string, within: ParentNode = container) =>
    [...within.querySelectorAll('button')].find((b) => b.textContent?.trim() === text)

  await press(container.querySelector('[aria-label="Select"]'), 'a photograph')
  await press(button('Select all'), 'Select all')
  await press(button(action), action)

  // A destructive action goes through a confirmation before anything is sent.
  const dialog = container.querySelector('[role="alertdialog"]')
  if (dialog) await press(button(action, dialog), `${action} (confirm)`)
}

const albumRoute = async () => {
  const { AlbumDetail } = await import('./AlbumDetail.tsx')
  return mount(`/albums/${ALBUM_ID}`, '/albums/:id', <AlbumDetail />)
}

describe('the filter each route selects under', () => {
  test('an album trashes that album, never the library', async () => {
    const container = await albumRoute()
    await selectAllThen(container, 'Move to trash')
    const sent = calls.find((c) => c.what === 'assets.trash')
    // `{}` here is a select-all inside one album that empties the whole library.
    expect(sent?.body).toEqual({ query: { albumId: ALBUM_ID }, except: [] })
  })

  test('an album removal is scoped to the album too', async () => {
    const container = await albumRoute()
    await selectAllThen(container, 'Remove from album')
    const sent = calls.find((c) => c.what === 'albums.removeAssets')
    expect(sent?.body).toEqual({ query: { albumId: ALBUM_ID }, except: [] })
  })

  test('the library route selects the filter it was given, not an empty one', async () => {
    const { Timeline } = await import('./Timeline.tsx')
    const container = await mount(
      '/favourites',
      '/favourites',
      <Timeline
        title="Favourites"
        query={{ favorite: true }}
        empty={{ headline: 'None', body: 'None' }}
      />,
    )
    await selectAllThen(container, 'Move to trash')
    expect(calls.find((c) => c.what === 'assets.trash')?.body).toEqual({
      query: { favorite: true },
      except: [],
    })
  })

  /*
   * The vault is the one view that must NOT send a filter. No filter can reach into the
   * vault, so a query-form selection would resolve to nothing server-side and read as a
   * successful no-op rather than the mistake it is.
   */
  test('the vault names its photographs, because no filter can name them', async () => {
    const { VaultRoute } = await import('./VaultRoute.tsx')
    const container = await mount('/vault', '/vault', <VaultRoute />)
    await selectAllThen(container, 'Move out of vault')
    expect(calls.find((c) => c.what === 'vault.moveOut')?.body).toEqual({
      assetIds: TILES.map((t) => t.id),
    })
  })
})

describe('where each route reads its grid from', () => {
  test('an album counts the spine, not the sample its own endpoint returned', async () => {
    const container = await albumRoute()
    expect(calls.some((c) => c.what === 'library:timeline')).toBe(true)
    expect(container.textContent).toContain('2 photos')
    // 30,000 is what `albums.get` claims; the grid and the header must agree with each
    // other, and the sixty-item sample is not what either of them is reading.
    expect(container.textContent).not.toContain('30,000')
  })

  test('a person counts the spine too', async () => {
    const { PersonDetail } = await import('./PersonDetail.tsx')
    const container = await mount(`/people/${PERSON_ID}`, '/people/:id', <PersonDetail />)
    expect(container.textContent).toContain('2 photos')
    expect(container.textContent).not.toContain('600')
  })

  test('the vault reads its own spine rather than the library timeline', async () => {
    const { VaultRoute } = await import('./VaultRoute.tsx')
    const container = await mount('/vault', '/vault', <VaultRoute />)
    expect(calls.some((c) => c.what === 'vault:timeline')).toBe(true)
    expect(calls.some((c) => c.what === 'library:timeline')).toBe(false)
    expect(container.textContent).toContain('2 photos')
  })
})

describe('a shared link never reaches an authenticated endpoint', () => {
  test('every URL it fetches is scoped to the slug', async () => {
    const { shareSource } = await import('./SharedAlbum.tsx')
    const asked: string[] = []
    const original = globalThis.fetch
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      asked.push(String(input))
      return new Response('{"buckets":[],"items":[],"nextCursor":null}', {
        headers: { 'Content-Type': 'application/json' },
      })
    }) as typeof fetch
    try {
      const source = shareSource('abc123')
      await source.timeline({ covers: true })
      await source.bucket({ period: '2019-06' })
      // No stats: a public page has no library count to watch and no session to ask with.
      expect(source.stats).toBeUndefined()
    } finally {
      globalThis.fetch = original
    }

    expect(asked).toEqual([
      '/api/v1/share/abc123/timeline?covers=true',
      '/api/v1/share/abc123/timeline/bucket?period=2019-06',
    ])
    for (const url of asked) expect(url.startsWith('/api/v1/share/abc123/')).toBe(true)
  })
})
