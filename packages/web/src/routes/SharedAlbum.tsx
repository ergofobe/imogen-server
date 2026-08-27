import type { Album, Asset } from '@imogen/shared'
import { useQuery } from '@tanstack/react-query'
import { useMemo, useState } from 'react'
import { useParams } from 'react-router'
import { TimelineBody, TimelineCount } from '../components/TimelineBody.tsx'
import { Viewer } from '../components/Viewer.tsx'
import { Wordmark } from '../components/Wordmark.tsx'
import type { TimelineSource } from '../hooks/useTimeline.ts'
import { useTimelineGrid } from '../hooks/useTimelineGrid.ts'
import { useTimelineViewer } from '../hooks/useTimelineViewer.ts'
import { ShareAssetUrls } from '../lib/assetUrls.tsx'

/** A share is one album by construction, so it is asked for with no filter of its own. */
const NO_FILTER = {}

type ShareResponse =
  | { locked: true }
  | {
      locked: false
      kind: 'album' | 'photo'
      album: Album & { assets: Asset[] }
      allowDownload: boolean
    }

/**
 * Everything this page fetches, through the slug and nothing else.
 *
 * A visitor has no session, so every one of these has to be a share-scoped URL: the
 * album is fixed server-side from the link, and there is no request any of them could
 * carry that would widen it. Reaching an authenticated endpoint from here would not
 * merely fail — it would mean the page had been built to expect a session it must never
 * have — so the fetches live in one place where that can be seen at a glance.
 */
export function shareSource(slug: string): TimelineSource {
  const get = async <T,>(path: string, query: Record<string, string> = {}): Promise<T> => {
    const search = new URLSearchParams(query).toString()
    const response = await fetch(`/api/v1/share/${slug}${path}${search ? `?${search}` : ''}`)
    if (!response.ok) throw new Error('That link is not valid, or it has expired')
    return response.json() as Promise<T>
  }
  return {
    key: `share:${slug}`,
    timeline: (query) => get('/timeline', query.covers ? { covers: 'true' } : {}),
    bucket: (query) =>
      get('/timeline/bucket', {
        period: query.period,
        ...(query.cursor ? { cursor: query.cursor } : {}),
      }),
    // No `stats`: there is no public library count to watch, and asking for one would be
    // an authenticated request from a page that has no business making any.
  }
}

/** A public album. No account, no session — the slug is the only credential. */
export function SharedAlbum() {
  const { slug = '' } = useParams()
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)

  const { data, refetch, isPending } = useQuery<ShareResponse>({
    queryKey: ['share', slug],
    queryFn: async () => {
      const response = await fetch(`/api/v1/share/${slug}`)
      if (response.status === 401) return { locked: true }
      if (!response.ok) throw new Error('This link is not valid, or it has expired')
      return response.json() as Promise<ShareResponse>
    },
    retry: false,
  })

  const source = useMemo(() => shareSource(slug), [slug])
  /*
   * The grid is the share's own timeline, not `album.assets`.
   *
   * That array is a capped cover sample, and the subtitle used to be `assets.length` — so
   * a shared album of thirty thousand photographs read "60 photos" over sixty tiles and
   * was perfectly self-consistent about it. Neither the recipient nor the sender had
   * anything to notice. The count now comes from the spine, which counts the album.
   */
  const grid = useTimelineGrid(NO_FILTER, {
    source,
    // A locked album has a password prompt where its grid goes, and nothing to fetch until
    // that is answered.
    enabled: Boolean(data) && data?.locked === false,
  })
  const viewer = useTimelineViewer({
    ...grid,
    scope: source.key,
    fetchAsset: async (id) => {
      const response = await fetch(`/api/v1/share/${slug}/assets/${id}`)
      if (!response.ok) throw new Error('That photo is not part of this album')
      return response.json() as Promise<Asset>
    },
  })

  async function unlock(event: React.FormEvent) {
    event.preventDefault()
    setError(null)
    const response = await fetch(`/api/v1/share/${slug}/unlock`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password }),
    })
    if (!response.ok) {
      setError('That password is not correct')
      return
    }
    void refetch()
  }

  if (isPending) return <div className="grid min-h-dvh place-items-center" />

  if (!data || data.locked) {
    return (
      <div className="grid min-h-dvh place-items-center px-5">
        <form onSubmit={unlock} className="w-full max-w-[20rem]">
          <div className="mb-7">
            <Wordmark />
          </div>
          <h1 className="heading-display mb-2 text-xl">This album needs a password</h1>
          <p className="mb-6 text-sm text-muted">Ask whoever shared the link for the password.</p>
          <input
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            autoComplete="off"
            className="mb-3 w-full rounded-lg border border-line bg-surface px-3 py-2.5 text-sm outline-none focus:border-safelight"
          />
          {error && <p className="mb-3 text-sm text-safelight">{error}</p>}
          <button
            type="submit"
            className="w-full rounded-lg bg-ink py-2.5 text-sm font-medium text-paper transition hover:opacity-90"
          >
            Open album
          </button>
        </form>
      </div>
    )
  }

  const assets = data.album.assets

  // A filename is an identifier, not a title. Whatever the owner wrote about the
  // photograph is the better thing to lead with when there is one.
  const photo = data.kind === 'photo' ? assets[0] : null
  const title = photo ? (photo.description ?? photo.originalFilename) : data.album.name
  const subtitle = photo
    ? new Date(photo.capturedAt).toLocaleDateString(undefined, {
        year: 'numeric',
        month: 'long',
        day: 'numeric',
      })
    : null

  return (
    <ShareAssetUrls slug={slug} allowDownload={data.allowDownload}>
      <div className="flex min-h-dvh flex-col">
        {/*
          A stranger opening this link may never have heard of imogen, and this page is
          the whole of what they see. The mark is stated properly at the top rather
          than tucked into a corner as a loose glyph.
        */}
        <header className="border-b border-line">
          <div className="mx-auto flex w-full max-w-[1600px] items-center justify-between gap-4 px-4 py-4 md:px-8">
            <Wordmark />
            <span className="label-micro text-muted">
              {data.kind === 'photo' ? 'A shared photo' : 'A shared album'}
            </span>
          </div>
        </header>

        <main className="mx-auto w-full max-w-[1600px] flex-1 px-4 py-8 md:px-8">
          <div className="mb-7 pr-11">
            <h1 className="heading-display text-2xl md:text-[28px]">{title}</h1>
            {subtitle ? (
              <p className="label-micro mt-1">{subtitle}</p>
            ) : (
              <TimelineCount
                totalCount={grid.totalCount}
                onShowOverview={() => grid.setShowingOverview(true)}
              />
            )}
          </div>

          {/*
            One photograph is shown as a photograph. Sending it through the timeline
            grid gives it a date heading and a row of its own to be small in, which is
            the layout answering a question nobody asked.
          */}
          {data.kind === 'photo' && assets[0] ? (
            <button
              type="button"
              onClick={() => viewer.open(assets[0]!.id)}
              className="block w-full max-w-3xl overflow-hidden rounded-xl border border-line bg-sunken"
            >
              <img
                src={`/api/v1/share/${slug}/assets/${assets[0].id}/preview`}
                alt={assets[0].description ?? assets[0].originalFilename}
                className="h-auto w-full object-contain"
              />
            </button>
          ) : (
            <TimelineBody
              grid={grid}
              filter={NO_FILTER}
              source={source}
              empty={{
                headline: 'Nothing here yet',
                body: 'This album has no photos in it.',
              }}
              onOpen={(tile) => viewer.open(tile.id)}
              // A visitor has nothing to do with a selection: there is no bar to act on it.
              selectable={false}
            />
          )}
        </main>

        <footer className="border-t border-line">
          <div className="mx-auto w-full max-w-[1600px] px-4 py-5 md:px-8">
            <p className="text-sm text-muted">
              Shared with{' '}
              <a
                href="https://github.com/ergofobe/imogen-server"
                className="underline decoration-line underline-offset-4 transition hover:text-ink"
              >
                imogen
              </a>
              , a photo library you run yourself.
            </p>
          </div>
        </footer>

        {viewer.asset && (
          <Viewer
            asset={viewer.asset}
            hasPrevious={viewer.hasPrevious}
            hasNext={viewer.hasNext}
            onClose={viewer.close}
            onPrevious={() => viewer.step(-1)}
            onNext={() => viewer.step(1)}
            onToggleFavorite={() => {}}
            onTrash={() => {}}
            editable={false}
          />
        )}
      </div>
    </ShareAssetUrls>
  )
}
