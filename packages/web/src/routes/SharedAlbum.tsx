import type { Album, Asset } from '@imogen/shared'
import { useQuery } from '@tanstack/react-query'
import { useMemo, useState } from 'react'
import { useParams } from 'react-router'
import { PhotoGrid } from '../components/PhotoGrid.tsx'
import { Viewer } from '../components/Viewer.tsx'
import { Wordmark } from '../components/Wordmark.tsx'
import { useGridLayout } from '../hooks/useGridLayout.ts'
import { useAssetTable } from '../hooks/useTimeline.ts'
import { useViewerParam } from '../hooks/useViewerParam.ts'
import { ShareAssetUrls } from '../lib/assetUrls.tsx'

type ShareResponse =
  | { locked: true }
  | {
      locked: false
      kind: 'album' | 'photo'
      album: Album & { assets: Asset[] }
      allowDownload: boolean
    }

/** A page with no selection still needs one object rather than a new Set every render. */
const EMPTY_SELECTION = new Set<string>()

/** A public album. No account, no session — the slug is the only credential. */
export function SharedAlbum() {
  const { slug = '' } = useParams()
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const { openId, open: openPhoto, replace: showPhoto, close: closePhoto } = useViewerParam()

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

  const { containerRef, options } = useGridLayout()
  const photographs = useMemo(() => (data && !data.locked ? data.album.assets : []), [data])
  const { table, tiles } = useAssetTable(photographs, options)

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
  const openIndex = openId ? assets.findIndex((a) => a.id === openId) : -1

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
    : `${assets.length} ${assets.length === 1 ? 'photo' : 'photos'}`

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
          <div className="mb-7">
            <h1 className="heading-display text-2xl md:text-[28px]">{title}</h1>
            {subtitle && <p className="label-micro mt-1">{subtitle}</p>}
          </div>

          {/*
            One photograph is shown as a photograph. Sending it through the timeline
            grid gives it a date heading and a row of its own to be small in, which is
            the layout answering a question nobody asked.
          */}
          {data.kind === 'photo' && assets[0] ? (
            <button
              type="button"
              onClick={() => openPhoto(assets[0]!.id)}
              className="block w-full max-w-3xl overflow-hidden rounded-xl border border-line bg-sunken"
            >
              <img
                src={`/api/v1/share/${slug}/assets/${assets[0].id}/preview`}
                alt={assets[0].description ?? assets[0].originalFilename}
                className="h-auto w-full object-contain"
              />
            </button>
          ) : (
            <PhotoGrid
              table={table}
              tiles={tiles}
              options={options}
              containerRef={containerRef}
              selected={EMPTY_SELECTION}
              onOpen={(tile) => openPhoto(tile.id)}
              onToggleSelect={() => {}}
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

        {openIndex >= 0 && assets[openIndex] && (
          <Viewer
            asset={assets[openIndex]}
            hasPrevious={openIndex > 0}
            hasNext={openIndex < assets.length - 1}
            onClose={() => closePhoto()}
            onPrevious={() => showPhoto(assets[openIndex - 1]?.id ?? '')}
            onNext={() => showPhoto(assets[openIndex + 1]?.id ?? '')}
            onToggleFavorite={() => {}}
            onTrash={() => {}}
            editable={false}
          />
        )}
      </div>
    </ShareAssetUrls>
  )
}
