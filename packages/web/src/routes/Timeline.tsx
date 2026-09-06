import type { Asset, AssetFilter, AssetSelection } from '@imogen/shared'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { useNavigate } from 'react-router'
import { AlbumPicker } from '../components/AlbumPicker.tsx'
import { Notice } from '../components/Notice.tsx'
import { SelectionBar } from '../components/SelectionBar.tsx'
import { TimelineBody, TimelineCount } from '../components/TimelineBody.tsx'
import { TimelineSkeleton } from '../components/TimelineSkeleton.tsx'
import { TrashConfirmation, useTrashConfirmation } from '../components/TrashConfirmation.tsx'
import { Viewer } from '../components/Viewer.tsx'
import { useOverviewKey } from '../hooks/useOverviewKey.ts'
import { useSelection } from '../hooks/useSelection.ts'
import { useTimelineGrid } from '../hooks/useTimelineGrid.ts'
import { useTimelineViewer } from '../hooks/useTimelineViewer.ts'
import { imogen } from '../lib/client.ts'
import type { VaultHandoff } from '../lib/vaultHandoff.ts'

type Props = {
  title: string
  query?: Partial<AssetFilter>
  empty: { headline: string; body: string; action?: React.ReactNode }
  /** Trash shows restore rather than delete. */
  mode?: 'library' | 'trash'
}

const NO_FILTER: Partial<AssetFilter> = {}

export function Timeline({ title, query = NO_FILTER, empty, mode = 'library' }: Props) {
  const queryClient = useQueryClient()
  const navigate = useNavigate()

  const grid = useTimelineGrid(query)
  const viewer = useTimelineViewer(grid)
  useOverviewKey(grid, viewer.openId)

  /*
   * The selection is a view of the FILTER, not of the loaded ids. `ids` is only the months in
   * hand, which is what shift-clicking a range walks along and nothing else; `totalCount` is
   * the spine's, so select-all resolves against the whole library rather than the window.
   */
  const selection = useSelection({
    query,
    orderedIds: grid.ids,
    totalCount: grid.totalCount,
  })

  const [pickingAlbum, setPickingAlbum] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const confirmation = useTrashConfirmation()

  const refresh = () => {
    // The open photograph is fetched whole and separately, so it has its own copy to update.
    void queryClient.invalidateQueries({ queryKey: ['asset'] })
    grid.reload()
  }

  const afterMutation = () => {
    selection.clear()
    refresh()
  }

  const favourite = useMutation({
    mutationFn: (asset: Asset) => imogen.assets.update(asset.id, { favorite: !asset.favorite }),
    onSuccess: refresh,
  })

  const trash = useMutation({
    mutationFn: (request: AssetSelection) => imogen.assets.trash(request),
    onSuccess: afterMutation,
  })

  /**
   * Moving into the vault needs the vault open. If it is locked we send the user to the
   * vault to unlock rather than asking for a passphrase inside a toolbar.
   *
   * The request goes with them. An unlock somebody was sent to BY an action has to finish
   * that action: this used to navigate and drop the selection on the floor, so the reader
   * arrived at an open vault with their photographs still in the library and nothing on
   * screen admitting that the thing they asked for had not happened.
   */
  const toVault = useMutation({
    mutationFn: async (request: AssetSelection) => {
      const status = await imogen.vault.status()
      if (!status.configured || !status.unlocked) {
        navigate('/vault', { state: { moveIn: request } satisfies VaultHandoff })
        return { moved: 0 }
      }
      return imogen.vault.moveIn(request)
    },
    onSuccess: afterMutation,
  })

  const restore = useMutation({
    mutationFn: (request: AssetSelection) => imogen.assets.restore(request),
    onSuccess: afterMutation,
  })

  if (grid.isPending) return <TimelineSkeleton title={title} />

  return (
    <>
      {/* `pr-11` clears the rail, which is fixed over the right edge of the viewport. The
          grid is left to slide under it — a translucent scrubber over the last inch is the
          conventional shape for one — but a control the reader has to hit is not. */}
      <div className="mb-5 flex items-baseline justify-between gap-4 pr-11">
        <h1 className="heading-display text-2xl md:text-[28px]">{title}</h1>
        <TimelineCount
          totalCount={grid.totalCount}
          onShowOverview={() => grid.setShowingOverview(true)}
        />
      </div>

      <TimelineBody
        grid={grid}
        filter={query}
        empty={empty}
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
          actions={
            mode === 'trash'
              ? [
                  {
                    label: 'Restore',
                    onClick: () => restore.mutate(selection.toRequest()),
                    icon: 'M4 12a8 8 0 1 0 2.3-5.6M4 4v4h4',
                  },
                ]
              : [
                  {
                    label: 'Add to album',
                    onClick: () => setPickingAlbum(true),
                    icon: 'M4 7h6l2 2h8v10H4zM12 12v5M9.5 14.5h5',
                  },
                  {
                    label: 'Move to vault',
                    onClick: () => toVault.mutate(selection.toRequest()),
                    icon: 'M4 11h16v9H4zM8 11V7a4 4 0 0 1 8 0v4',
                  },
                  {
                    label: 'Move to trash',
                    onClick: () => confirmation.ask(selection),
                    icon: 'M5 7h14M9 7V5h6v2M7 7l1 12h8l1-12',
                  },
                ]
          }
        />
      )}

      <TrashConfirmation
        confirmation={confirmation}
        onConfirm={(request) => {
          viewer.close()
          trash.mutate(request)
        }}
      />

      {pickingAlbum && (
        <AlbumPicker
          selection={selection.toRequest()}
          count={selection.count}
          onClose={() => setPickingAlbum(false)}
          onDone={(message) => {
            setPickingAlbum(false)
            selection.clear()
            setNotice(message)
          }}
        />
      )}

      <Notice notice={notice} onDone={() => setNotice(null)} />

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
