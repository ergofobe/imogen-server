import type { Asset, AssetFilter, TimelineTile } from '@imogen/shared'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router'
import { AlbumPicker } from '../components/AlbumPicker.tsx'
import { ConfirmDialog } from '../components/ConfirmDialog.tsx'
import { EmptyState } from '../components/EmptyState.tsx'
import { PhotoGrid } from '../components/PhotoGrid.tsx'
import { SelectionBar } from '../components/SelectionBar.tsx'
import { Viewer } from '../components/Viewer.tsx'
import { neighbouringPeriod, tilesInTimelineOrder } from '../hooks/timelineWindow.ts'
import { useGridLayout } from '../hooks/useGridLayout.ts'
import { useSelection } from '../hooks/useSelection.ts'
import { useTimeline } from '../hooks/useTimeline.ts'
import { useViewerParam } from '../hooks/useViewerParam.ts'
import { imogen } from '../lib/client.ts'
import { periodOf, segmentsInRange } from '../lib/timelineLayout.ts'

type Props = {
  title: string
  query?: Partial<AssetFilter>
  empty: { headline: string; body: string; action?: React.ReactNode }
  /** Trash shows restore rather than delete. */
  mode?: 'library' | 'trash'
}

export function Timeline({ title, query = {}, empty, mode = 'library' }: Props) {
  const queryClient = useQueryClient()
  const { openId, open: openPhoto, replace: showPhoto, close: closePhoto } = useViewerParam()

  const { containerRef, options } = useGridLayout()
  const { table, tiles, isPending, totalCount, requestPeriods, reload } = useTimeline(
    query,
    options,
  )

  /** Only the loaded months, but in true timeline order rather than in arrival order. */
  const ordered = useMemo(() => tilesInTimelineOrder(table, tiles), [table, tiles])
  const ids = useMemo(() => ordered.map((tile) => tile.id), [ordered])
  const { selected, toggle, clear, selectAll } = useSelection(ids)

  const [pickingAlbum, setPickingAlbum] = useState(false)
  const [confirmingTrash, setConfirmingTrash] = useState<string[] | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  // The confirmation says what happened and then gets out of the way.
  useEffect(() => {
    if (!notice) return
    const timer = setTimeout(() => setNotice(null), 4000)
    return () => clearTimeout(timer)
  }, [notice])

  const refresh = useCallback(() => {
    // The open photograph is fetched whole and separately, so it has its own copy to update.
    void queryClient.invalidateQueries({ queryKey: ['asset'] })
    reload()
  }, [queryClient, reload])

  const favourite = useMutation({
    mutationFn: (asset: Asset) => imogen.assets.update(asset.id, { favorite: !asset.favorite }),
    onSuccess: refresh,
  })

  const trash = useMutation({
    mutationFn: (assetIds: string[]) => imogen.assets.trash(assetIds),
    onSuccess: () => {
      clear()
      refresh()
    },
  })

  /**
   * Moving into the vault needs the vault open. If it is locked we send the user to the
   * vault to unlock rather than asking for a passphrase inside a toolbar.
   */
  const navigate = useNavigate()
  const toVault = useMutation({
    mutationFn: async (assetIds: string[]) => {
      const status = await imogen.vault.status()
      if (!status.configured || !status.unlocked) {
        navigate('/vault')
        return { moved: 0 }
      }
      return imogen.vault.moveIn(assetIds)
    },
    onSuccess: () => {
      clear()
      refresh()
    },
  })

  const restore = useMutation({
    mutationFn: (assetIds: string[]) => imogen.assets.restore(assetIds),
    onSuccess: () => {
      clear()
      refresh()
    },
  })

  /** What the reader can see, kept so the viewer can ask for a month without unpinning it. */
  const onScreenPeriods = useRef<string[]>([])

  const onVisibleRangeChange = useCallback(
    (top: number, bottom: number) => {
      const periods = new Set<string>()
      for (const segment of segmentsInRange(table, top, bottom)) periods.add(periodOf(segment.date))
      onScreenPeriods.current = [...periods]
      requestPeriods(onScreenPeriods.current)
    },
    [table, requestPeriods],
  )

  /**
   * The viewer needs the whole asset — exif, place, description, the corrected date — and a
   * tile carries none of that. Fetching the one photograph that is open costs a request the
   * grid would otherwise have paid for every photograph in the month.
   */
  const viewing = useQuery({
    queryKey: ['asset', openId],
    queryFn: () => imogen.assets.get(openId as string),
    enabled: Boolean(openId),
  })
  const open = openId && viewing.data?.id === openId ? viewing.data : null

  const openIndex = useMemo(
    () => (openId ? ordered.findIndex((tile) => tile.id === openId) : -1),
    [ordered, openId],
  )

  /** Set when a step ran off the end of the loaded months; taken once one more arrives. */
  const pendingStep = useRef<number | null>(null)

  const step = useCallback(
    (delta: number) => {
      if (openIndex < 0) return
      const next = ordered[openIndex + delta]
      if (next) {
        pendingStep.current = null
        showPhoto(next.id)
        return
      }
      // Off the edge of what is loaded. The next photograph exists — the spine says so —
      // but its month has not been fetched, so ask for it and take the step when it lands.
      const edge = delta > 0 ? ordered.at(-1) : ordered[0]
      if (!edge) return
      const period = neighbouringPeriod(table, edge.capturedAt.slice(0, 10), delta)
      if (!period) return
      pendingStep.current = delta
      requestPeriods([...new Set([...onScreenPeriods.current, period])])
    },
    [ordered, openIndex, showPhoto, table, requestPeriods],
  )

  useEffect(() => {
    const delta = pendingStep.current
    if (delta === null || openIndex < 0) return
    const arrived = ordered[openIndex + delta]
    if (!arrived) return
    pendingStep.current = null
    showPhoto(arrived.id)
  }, [ordered, openIndex, showPhoto])

  const edges = useMemo(() => atEdges(table, ordered, openIndex), [table, ordered, openIndex])

  if (isPending) return <TimelineSkeleton title={title} />

  return (
    <>
      <div className="mb-5 flex items-baseline justify-between gap-4">
        <h1 className="heading-display text-2xl md:text-[28px]">{title}</h1>
        {/* The spine counts every day the filter matches, so this is the number, not a floor. */}
        {totalCount > 0 && (
          <span className="label-micro">
            {totalCount} {totalCount === 1 ? 'photo' : 'photos'}
          </span>
        )}
      </div>

      {totalCount === 0 ? (
        <EmptyState headline={empty.headline} body={empty.body} action={empty.action} />
      ) : (
        <PhotoGrid
          table={table}
          tiles={tiles}
          options={options}
          containerRef={containerRef}
          selected={selected}
          onOpen={(tile) => openPhoto(tile.id)}
          onToggleSelect={(tile, shiftKey) => toggle(tile.id, shiftKey)}
          onVisibleRangeChange={onVisibleRangeChange}
        />
      )}

      {selected.size > 0 && (
        <SelectionBar
          count={selected.size}
          onClear={clear}
          onSelectAll={selectAll}
          actions={
            mode === 'trash'
              ? [
                  {
                    label: 'Restore',
                    onClick: () => restore.mutate([...selected]),
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
                    onClick: () => toVault.mutate([...selected]),
                    icon: 'M4 11h16v9H4zM8 11V7a4 4 0 0 1 8 0v4',
                  },
                  {
                    label: 'Move to trash',
                    onClick: () => setConfirmingTrash([...selected]),
                    icon: 'M5 7h14M9 7V5h6v2M7 7l1 12h8l1-12',
                  },
                ]
          }
        />
      )}

      {confirmingTrash && (
        <ConfirmDialog
          title={
            confirmingTrash.length === 1
              ? 'Move this photo to the trash?'
              : `Move ${confirmingTrash.length} photos to the trash?`
          }
          body={
            confirmingTrash.length === 1
              ? 'It leaves the timeline and every album. You can put it back from the trash until it is swept.'
              : 'They leave the timeline and every album. You can put them back from the trash until it is swept.'
          }
          confirmLabel="Move to trash"
          destructive
          onConfirm={() => {
            const ids = confirmingTrash
            setConfirmingTrash(null)
            closePhoto()
            trash.mutate(ids)
          }}
          onCancel={() => setConfirmingTrash(null)}
        />
      )}

      {pickingAlbum && (
        <AlbumPicker
          assetIds={[...selected]}
          onClose={() => setPickingAlbum(false)}
          onDone={(message) => {
            setPickingAlbum(false)
            clear()
            setNotice(message)
          }}
        />
      )}

      {notice && (
        <div className="fixed inset-x-0 bottom-0 z-50 flex justify-center p-4 pb-[max(1rem,calc(env(safe-area-inset-bottom)+4.5rem))] md:pb-6">
          <p className="surface-panel rounded-full px-4 py-2 text-sm">{notice}</p>
        </div>
      )}

      {open && (
        <Viewer
          asset={open}
          hasPrevious={edges.hasPrevious}
          hasNext={edges.hasNext}
          onClose={() => closePhoto()}
          onPrevious={() => step(-1)}
          onNext={() => step(1)}
          onToggleFavorite={(asset) => favourite.mutate(asset)}
          onTrash={(asset) => {
            closePhoto()
            trash.mutate([asset.id])
          }}
        />
      )}
    </>
  )
}

/**
 * Whether there is anything either side of the open photograph, judged against the whole
 * timeline rather than the loaded months: the arrows have to stay lit at the seam between
 * two months, or stepping across one would look like the end of the library.
 */
function atEdges(
  table: { segments: Array<{ date: string }> },
  ordered: TimelineTile[],
  openIndex: number,
): { hasPrevious: boolean; hasNext: boolean } {
  if (openIndex < 0) return { hasPrevious: false, hasNext: false }
  const dayOf = (tile: TimelineTile | undefined) => tile?.capturedAt.slice(0, 10)
  const indexOfDay = (date: string | undefined) =>
    date === undefined ? -1 : table.segments.findIndex((segment) => segment.date === date)

  const first = indexOfDay(dayOf(ordered[0]))
  const last = indexOfDay(dayOf(ordered.at(-1)))
  return {
    hasPrevious: openIndex > 0 || first > 0,
    hasNext: openIndex < ordered.length - 1 || (last >= 0 && last < table.segments.length - 1),
  }
}

/** Mirrors the real grid's rhythm, so nothing jumps when the photos arrive. */
function TimelineSkeleton({ title }: { title: string }) {
  return (
    <>
      <h1 className="heading-display mb-5 text-2xl md:text-[28px]">{title}</h1>
      {/* biome-ignore-start lint/suspicious/noArrayIndexKey: a fixed skeleton never reorders */}
      <div className="space-y-1">
        {[3, 4, 3, 5].map((count, row) => (
          <div key={`row-${row}-${count}`} className="flex gap-1" style={{ height: 200 }}>
            {Array.from({ length: count }, (_, i) => (
              <div
                key={`cell-${row}-${i}`}
                className="animate-pulse rounded-[--radius-tile] bg-sunken"
                style={{ flex: `${1 + ((i * 7) % 5) / 10} 1 0` }}
              />
            ))}
          </div>
        ))}
      </div>
      {/* biome-ignore-end lint/suspicious/noArrayIndexKey: a fixed skeleton never reorders */}
    </>
  )
}
