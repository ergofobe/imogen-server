import type { AssetSelection } from '@imogen/shared'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useMemo, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router'
import { ConfirmDialog } from '../components/ConfirmDialog.tsx'
import { EmptyState } from '../components/EmptyState.tsx'
import { PhotoGrid } from '../components/PhotoGrid.tsx'
import { SelectionBar } from '../components/SelectionBar.tsx'
import { SharePanel } from '../components/SharePanel.tsx'
import { Viewer } from '../components/Viewer.tsx'
import { useGridLayout } from '../hooks/useGridLayout.ts'
import { useSelection } from '../hooks/useSelection.ts'
import { useAssetTable } from '../hooks/useTimeline.ts'
import { useViewerParam } from '../hooks/useViewerParam.ts'
import { imogen } from '../lib/client.ts'

export function AlbumDetail() {
  const { id = '' } = useParams()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const { openId, open: openPhoto, replace: showPhoto, close: closePhoto } = useViewerParam()
  const [sharing, setSharing] = useState(false)
  // Taken when the dialog opens, so the reader confirms the number they were shown.
  const [confirmingTrash, setConfirmingTrash] = useState<{
    request: AssetSelection
    count: number
  } | null>(null)

  const { data: album, isPending } = useQuery({
    queryKey: ['album', id],
    queryFn: () => imogen.albums.get(id),
  })

  // Hooks cannot wait for the album to arrive, so the ids are read defensively.
  const ids = useMemo(() => album?.assets.map((asset) => asset.id) ?? [], [album])
  /*
   * `{ albumId }` is what this page is a view of, so select-all here is that filter rather
   * than a list — which matters for an album past the thousand ids a request will carry, and
   * for one whose assets the endpoint has not sent in full.
   */
  const { count, selecting, isSelected, toggle, clear, selectAll, toRequest, refusal } =
    useSelection({ query: { albumId: id }, orderedIds: ids, totalCount: album?.assetCount ?? 0 })

  // The album is fetched whole, so the grid gets its geometry rather than its machinery.
  const { attachContainer, options } = useGridLayout()
  const photographs = useMemo(() => album?.assets ?? [], [album])
  const { table, tiles } = useAssetTable(photographs, options)

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ['album', id] })
    void queryClient.invalidateQueries({ queryKey: ['albums'] })
  }

  /** Takes photographs out of the album. They stay in the library. */
  const removeFromAlbum = useMutation({
    mutationFn: (selection: AssetSelection) => imogen.albums.removeAssets(id, selection),
    onSuccess: () => {
      clear()
      refresh()
    },
  })

  const trash = useMutation({
    mutationFn: (selection: AssetSelection) => imogen.assets.trash(selection),
    onSuccess: () => {
      clear()
      setConfirmingTrash(null)
      refresh()
      void queryClient.invalidateQueries({ queryKey: ['assets'] })
      void queryClient.invalidateQueries({ queryKey: ['timeline'] })
    },
  })

  const remove = useMutation({
    mutationFn: () => imogen.albums.remove(id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['albums'] })
      navigate('/albums')
    },
  })

  if (isPending || !album) return <div className="h-40 animate-pulse rounded-lg bg-sunken" />

  const assets = album.assets
  const openIndex = openId ? assets.findIndex((a) => a.id === openId) : -1

  return (
    <>
      <Link
        to="/albums"
        className="label-micro mb-4 inline-flex items-center gap-1.5 hover:text-ink"
      >
        <svg
          aria-hidden="true"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          className="h-3.5 w-3.5"
        >
          <path d="M15 5l-7 7 7 7" />
        </svg>
        Albums
      </Link>

      <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="heading-display text-2xl md:text-[28px]">{album.name}</h1>
          <p className="label-micro mt-1">
            {album.assetCount} {album.assetCount === 1 ? 'photo' : 'photos'}
          </p>
        </div>

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setSharing((open) => !open)}
            aria-expanded={sharing}
            className="rounded-lg border border-line px-3 py-1.5 text-sm transition hover:bg-sunken"
          >
            {album.shareSlug ? 'Sharing' : 'Share'}
          </button>
          <button
            type="button"
            onClick={() => remove.mutate()}
            className="rounded-lg px-3 py-1.5 text-sm text-muted transition hover:text-ink"
          >
            Delete album
          </button>
        </div>
      </div>

      {sharing && (
        <div className="mb-6 max-w-xl">
          <SharePanel target={{ kind: 'album', id }} onClose={() => setSharing(false)} />
        </div>
      )}

      {assets.length === 0 ? (
        <EmptyState
          headline="This album is empty"
          body="Select photos in your timeline and add them here."
        />
      ) : (
        <PhotoGrid
          table={table}
          tiles={tiles}
          options={options}
          attachContainer={attachContainer}
          isSelected={isSelected}
          selecting={selecting}
          onOpen={(tile) => openPhoto(tile.id)}
          onToggleSelect={(tile, shiftKey) => toggle(tile.id, shiftKey)}
        />
      )}

      {selecting && (
        <SelectionBar
          count={count}
          onClear={clear}
          onSelectAll={selectAll}
          refusal={refusal}
          actions={[
            {
              label: 'Remove from album',
              onClick: () => removeFromAlbum.mutate(toRequest()),
              icon: 'M5 12h14',
            },
            {
              label: 'Move to trash',
              onClick: () => setConfirmingTrash({ request: toRequest(), count }),
              icon: 'M5 7h14M9 7V5h6v2M7 7l1 12h8l1-12',
            },
          ]}
        />
      )}

      {confirmingTrash && (
        <ConfirmDialog
          title={
            confirmingTrash.count === 1
              ? 'Move this photo to the trash?'
              : `Move ${confirmingTrash.count.toLocaleString()} photos to the trash?`
          }
          body={
            confirmingTrash.count === 1
              ? 'It leaves the timeline and every album. You can put it back from the trash until it is swept.'
              : 'They leave the timeline and every album. You can put them back from the trash until it is swept.'
          }
          confirmLabel="Move to trash"
          destructive
          onConfirm={() => trash.mutate(confirmingTrash.request)}
          onCancel={() => setConfirmingTrash(null)}
        />
      )}

      {openIndex >= 0 && assets[openIndex] && (
        <Viewer
          asset={assets[openIndex]}
          hasPrevious={openIndex > 0}
          hasNext={openIndex < assets.length - 1}
          onClose={() => closePhoto()}
          onPrevious={() => showPhoto(assets[openIndex - 1]?.id ?? '')}
          onNext={() => showPhoto(assets[openIndex + 1]?.id ?? '')}
          onToggleFavorite={(asset) => {
            void imogen.assets
              .update(asset.id, { favorite: !asset.favorite })
              .then(() => queryClient.invalidateQueries({ queryKey: ['album', id] }))
          }}
          onTrash={(asset) => {
            closePhoto()
            void imogen.assets
              .trash({ assetIds: [asset.id] })
              .then(() => queryClient.invalidateQueries({ queryKey: ['album', id] }))
          }}
        />
      )}
    </>
  )
}
