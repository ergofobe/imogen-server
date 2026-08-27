import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test'
import type { Asset } from '@imogen/shared'
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
 * What the viewer asks for on a page that has no session.
 *
 * A shared album is opened by strangers, and every request it makes has to go through the
 * slug. The details panel was the hole: `PeopleInPhoto` asks `/people/status` the moment it
 * mounts, so pressing `i` on a shared photograph fired an authenticated request from a
 * browser with no account. It answered 401 and nothing leaked, but a page built for people
 * who have no login should not be asking the library anything — and "nothing leaked" is a
 * property of the response, not of the page, which is the wrong place for it to live.
 *
 * The earlier browser confirmation missed this because the sample never opened the panel.
 */
const asked: string[] = []

mock.module('../lib/client.ts', () => ({
  imogen: {
    people: {
      status: () => {
        asked.push('people.status')
        return Promise.resolve({ enabled: true })
      },
      facesIn: () => {
        asked.push('people.facesIn')
        return Promise.resolve([])
      },
    },
    assets: { update: () => Promise.resolve(null), urlFor: () => '', downloadUrl: () => '' },
  },
}))

const ASSET = {
  id: 'aaaaaaaa-1111-4111-8111-111111111111',
  originalFilename: 'holiday.jpg',
  description: null,
  capturedAt: '2019-06-14T10:00:00.000Z',
  capturedAtIsExact: true,
  // Present and null, not absent: `CaptureDate` reads `capturedAtOriginal !== null` to
  // decide whether the date was corrected, so a missing field reads as "corrected" and
  // then formats an undefined date.
  capturedAtOriginal: null,
  capturedAtOriginalIsExact: null,
  width: 4032,
  height: 3024,
  type: 'image',
  status: 'ready',
  favorite: false,
  archived: false,
  mimeType: 'image/jpeg',
  sizeBytes: 100,
  duration: null,
  placeholderColor: null,
  livePhotoVideoId: null,
  exif: null,
  latitude: null,
  longitude: null,
  place: null,
} as unknown as Asset

async function openDetails(editable: boolean) {
  const { act } = await import('react')
  const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query')
  const { MemoryRouter } = await import('react-router')
  const { Viewer } = await import('./Viewer.tsx')

  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
  const container = await render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <Viewer
          asset={ASSET}
          hasPrevious={false}
          hasNext={false}
          onClose={() => {}}
          onPrevious={() => {}}
          onNext={() => {}}
          onToggleFavorite={() => {}}
          onTrash={() => {}}
          editable={editable}
        />
      </MemoryRouter>
    </QueryClientProvider>,
  )

  const details = [...container.querySelectorAll('button')].find(
    (b) => b.getAttribute('aria-label') === 'Photo details',
  )
  if (!details) throw new Error('no details button')
  await act(async () => {
    details.click()
  })
  for (let i = 0; i < 8; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
  }
  return container
}

describe('the details panel on a page with no session', () => {
  test('asks the library nothing', async () => {
    asked.length = 0
    const container = await openDetails(false)

    expect(asked).toEqual([])
    // The panel is still there and still useful — it just does not reach for the library.
    expect(container.textContent).toContain('holiday.jpg')
  })

  test('but asks for the people in the photograph when there is a session', async () => {
    asked.length = 0
    await openDetails(true)

    expect(asked).toContain('people.status')
  })
})
