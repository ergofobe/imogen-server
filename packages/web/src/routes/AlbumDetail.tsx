import type { AssetSelection } from '@imogen/shared'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useMemo, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router'
import { SelectionBar } from '../components/SelectionBar.tsx'
import { SharePanel } from '../components/SharePanel.tsx'
import { TimelineBody, TimelineCount } from '../components/TimelineBody.tsx'
import { TimelineSkeleton } from '../components/TimelineSkeleton.tsx'
import { TrashConfirmation, useTrashConfirmation } from '../components/TrashConfirmation.tsx'
import { Viewer } from '../components/Viewer.tsx'
import { useOverviewKey } from '../hooks/useOverviewKey.ts'
import { useSelection } from '../hooks/useSelection.ts'
import { useTimelineGrid } from '../hooks/useTimelineGrid.ts'
import { useTimelineViewer } from '../hooks/useTimelineViewer.ts'
import { imogen } from '../lib/client.ts'

export function AlbumDetail() {
  const { id = '' } = useParams()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const [sharing, setSharing] = useState(false)

  const { data: album, isPending } = useQuery({
    queryKey: ['album', id],
    queryFn: () => imogen.albums.get(id),
  })

  /*
   * The grid is the timeline under `{ albumId }`, not `album.assets`.
   *
   * `albums.get` answers with a capped cover sample — sixty photographs — which is the
   * right size for a header and emphatically the wrong size for a grid. Reading the grid
   * from it drew sixty tiles under a heading that said thirty thousand, sized the scroller
   * to sixty so there was no blank region to notice and no more to ask for, and left the
   * viewer's next arrow dead at the sixtieth photograph. The filter has no such ceiling.
   */
  const filter = useMemo(() => ({ albumId: id }), [id])
  const grid = useTimelineGrid(filter)
  const viewer = useTimelineViewer(grid)
  useOverviewKey(grid, viewer.openId)

  /*
   * Select-all here is the album, not the tiles in hand — which is what makes it right for
   * an album past a thousand photographs, where an id list is not even expressible.
   * `totalCount` is the spine's own, so it agrees with the grid by construction.
   */
  const selection = useSelection({
    query: filter,
    orderedIds: grid.ids,
    totalCount: grid.totalCount,
  })
  const confirmation = useTrashConfirmation()

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ['album', id] })
    void queryClient.invalidateQueries({ queryKey: ['albums'] })
    void queryClient.invalidateQueries({ queryKey: ['asset'] })
    grid.reload()
  }

  const afterMutation = () => {
    selection.clear()
    refresh()
  }

  /** Takes photographs out of the album. They stay in the library. */
  const removeFromAlbum = useMutation({
    mutationFn: (request: AssetSelection) => imogen.albums.removeAssets(id, request),
    onSuccess: afterMutation,
  })

  const trash = useMutation({
    mutationFn: (request: AssetSelection) => imogen.assets.trash(request),
    onSuccess: afterMutation,
  })

  const favourite = useMutation({
    mutationFn: (asset: { id: string; favorite: boolean }) =>
      imogen.assets.update(asset.id, { favorite: !asset.favorite }),
    onSuccess: refresh,
  })

  const remove = useMutation({
    mutationFn: () => imogen.albums.remove(id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['albums'] })
      navigate('/albums')
    },
  })

  if (isPending || !album) return <TimelineSkeleton />

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

      <div className="mb-6 flex flex-wrap items-end justify-between gap-3 pr-11">
        <div>
          <h1 className="heading-display text-2xl md:text-[28px]">{album.name}</h1>
          <TimelineCount
            totalCount={grid.totalCount}
            onShowOverview={() => grid.setShowingOverview(true)}
          />
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

      <TimelineBody
        grid={grid}
        filter={filter}
        empty={{
          headline: 'This album is empty',
          body: 'Select photos in your timeline and add them here.',
        }}
        isSelected={selection.isSelected}
        selecting={selection.selecting}
        onOpen={(tile) => viewer.open(tile.id)}
        onToggleSelect={(tile, shiftKey) => selection.toggle(tile.id, shiftKey)}
      />

      {selection.selecting && (
        <SelectionBar
          count={selection.count}
          onClear={selection.clear}
          onSelectAll={selection.selectAll}
          canSelectAll={selection.canSelectAll}
          refusal={selection.refusal}
          actions={[
            {
              label: 'Remove from album',
              onClick: () => removeFromAlbum.mutate(selection.toRequest()),
              icon: 'M5 12h14',
            },
            {
              label: 'Move to trash',
              onClick: () => confirmation.ask(selection),
              icon: 'M5 7h14M9 7V5h6v2M7 7l1 12h8l1-12',
            },
          ]}
        />
      )}

      <TrashConfirmation
        confirmation={confirmation}
        onConfirm={(request) => {
          viewer.close()
          trash.mutate(request)
        }}
      />

      {viewer.asset && (
        <Viewer
          asset={viewer.asset}
          hasPrevious={viewer.hasPrevious}
          hasNext={viewer.hasNext}
          onClose={viewer.close}
          onPrevious={() => viewer.step(-1)}
          onNext={() => viewer.step(1)}
          onToggleFavorite={(asset) => favourite.mutate(asset)}
          onTrash={(asset) => {
            viewer.close()
            trash.mutate({ assetIds: [asset.id] })
          }}
        />
      )}
    </>
  )
}
