import type { Asset, AssetFilter, AssetSelection, TimelineTile } from '@imogen/shared'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router'
import { AlbumPicker } from '../components/AlbumPicker.tsx'
import { ConfirmDialog } from '../components/ConfirmDialog.tsx'
import { EmptyState } from '../components/EmptyState.tsx'
import { PhotoGrid } from '../components/PhotoGrid.tsx'
import { SelectionBar } from '../components/SelectionBar.tsx'
import { TimelineOverview } from '../components/TimelineOverview.tsx'
import { TimelineRail } from '../components/TimelineRail.tsx'
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

  const { attachContainer, options } = useGridLayout()
  const { table, tiles, isPending, totalCount, requestPeriods, suspendFetching, reload } =
    useTimeline(query, options)

  /**
   * The grid element, held here as well as inside `PhotoGrid`, because the rail and the
   * overview both write the scroll position the grid reads and need its coordinate space
   * to do it. State rather than a ref: the rail has to render again once the element
   * exists, and a ref would not tell it that it does.
   */
  const [grid, setGrid] = useState<HTMLDivElement | null>(null)
  const attachGrid = useCallback(
    (element: HTMLDivElement | null) => {
      setGrid(element)
      attachContainer(element)
    },
    [attachContainer],
  )

  const [showingOverview, setShowingOverview] = useState(false)

  /** Only the loaded months, but in true timeline order rather than in arrival order. */
  const ordered = useMemo(() => tilesInTimelineOrder(table, tiles), [table, tiles])
  const ids = useMemo(() => ordered.map((tile) => tile.id), [ordered])
  /*
   * The selection is a view of the FILTER, not of the loaded ids. `ids` is only the months in
   * hand, which is what shift-clicking a range walks along and nothing else; `totalCount` is
   * the spine's, so select-all resolves against the whole library rather than the window.
   */
  const { count, selecting, isSelected, toggle, clear, selectAll, toRequest, refusal } =
    useSelection({ query, orderedIds: ids, totalCount })

  const [pickingAlbum, setPickingAlbum] = useState(false)
  /*
   * The request and its count are taken when the dialog opens rather than read when it is
   * confirmed. What the reader agreed to is the number they were shown, and a selection that
   * changed behind an open dialog would make the two different things.
   */
  const [confirmingTrash, setConfirmingTrash] = useState<{
    request: AssetSelection
    count: number
  } | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  // The confirmation says what happened and then gets out of the way.
  useEffect(() => {
    if (!notice) return
    const timer = setTimeout(() => setNotice(null), 4000)
    return () => clearTimeout(timer)
  }, [notice])

  /**
   * `z` for the overview — zoom out. Guarded rather than bound bare: the viewer owns the
   * keyboard while it is open, and a letter typed into a search field or a description is
   * a letter, not a shortcut.
   */
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'z' || event.metaKey || event.ctrlKey || event.altKey) return
      if (openId) return
      const target = event.target
      if (target instanceof HTMLElement && target.closest('input, textarea, [contenteditable]')) {
        return
      }
      setShowingOverview((open) => !open)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [openId])

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
    mutationFn: (selection: AssetSelection) => imogen.assets.trash(selection),
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
    mutationFn: async (selection: AssetSelection) => {
      const status = await imogen.vault.status()
      if (!status.configured || !status.unlocked) {
        navigate('/vault')
        return { moved: 0 }
      }
      return imogen.vault.moveIn(selection)
    },
    onSuccess: () => {
      clear()
      refresh()
    },
  })

  const restore = useMutation({
    mutationFn: (selection: AssetSelection) => imogen.assets.restore(selection),
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
      {/* `pr-11` clears the rail, which is fixed over the right edge of the viewport. The
          grid is left to slide under it — a translucent scrubber over the last inch is the
          conventional shape for one — but a control the reader has to hit is not. */}
      <div className="mb-5 flex items-baseline justify-between gap-4 pr-11">
        <h1 className="heading-display text-2xl md:text-[28px]">{title}</h1>
        <div className="flex items-baseline gap-4">
          {/* The spine counts every day the filter matches, so this is the number, not a floor. */}
          {totalCount > 0 && (
            <span className="label-micro">
              {totalCount} {totalCount === 1 ? 'photo' : 'photos'}
            </span>
          )}
          {totalCount > 0 && (
            <button
              type="button"
              onClick={() => setShowingOverview(true)}
              className="rounded-lg border border-line px-2.5 py-1 text-sm transition hover:bg-sunken"
            >
              Overview
              <kbd className="label-micro ml-2 text-muted">z</kbd>
            </button>
          )}
        </div>
      </div>

      {totalCount === 0 ? (
        <EmptyState headline={empty.headline} body={empty.body} action={empty.action} />
      ) : (
        <PhotoGrid
          table={table}
          tiles={tiles}
          options={options}
          attachContainer={attachGrid}
          isSelected={isSelected}
          selecting={selecting}
          onOpen={(tile) => openPhoto(tile.id)}
          onToggleSelect={(tile, shiftKey) => toggle(tile.id, shiftKey)}
          onVisibleRangeChange={onVisibleRangeChange}
        />
      )}

      {totalCount > 0 && (
        <TimelineRail table={table} grid={grid} suspendFetching={suspendFetching} />
      )}

      {showingOverview && (
        <TimelineOverview
          table={table}
          filter={query}
          grid={grid}
          onClose={() => setShowingOverview(false)}
        />
      )}

      {selecting && (
        <SelectionBar
          count={count}
          onClear={clear}
          onSelectAll={selectAll}
          refusal={refusal}
          actions={
            mode === 'trash'
              ? [
                  {
                    label: 'Restore',
                    onClick: () => restore.mutate(toRequest()),
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
                    onClick: () => toVault.mutate(toRequest()),
                    icon: 'M4 11h16v9H4zM8 11V7a4 4 0 0 1 8 0v4',
                  },
                  {
                    label: 'Move to trash',
                    onClick: () => setConfirmingTrash({ request: toRequest(), count }),
                    icon: 'M5 7h14M9 7V5h6v2M7 7l1 12h8l1-12',
                  },
                ]
          }
        />
      )}

      {confirmingTrash && (
        <ConfirmDialog
          /*
           * The resolved figure, always. Under select-all this is the one place the reader
           * finds out whether "everything" is the twelve photographs on screen or ninety
           * thousand across twenty years, and a dialog that says "all photos" is asking them
           * to agree to a number it declined to tell them.
           */
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
          onConfirm={() => {
            const { request } = confirmingTrash
            setConfirmingTrash(null)
            closePhoto()
            trash.mutate(request)
          }}
          onCancel={() => setConfirmingTrash(null)}
        />
      )}

      {pickingAlbum && (
        <AlbumPicker
          selection={toRequest()}
          count={count}
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
            trash.mutate({ assetIds: [asset.id] })
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
