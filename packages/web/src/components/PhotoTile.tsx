import type { Asset, TimelineTile } from '@imogen/shared'
import { useAssetUrls } from '../lib/assetUrls.tsx'
import { formatCaptureMoment, formatDuration } from '../lib/format.ts'

/**
 * A tile draws from whichever of the two shapes the caller happens to hold. The windowed
 * timeline fetches `TimelineTile`, which is an `Asset` with everything a tile never reads
 * left out; an album or a shared link already holds whole `Asset`s. The two agree on every
 * field below except the filename, which only exists on one of them and only ever reaches
 * a screen reader.
 */
export type TileSubject = Asset | TimelineTile

type Props = {
  asset: TileSubject
  width: number
  height: number
  selected: boolean
  selectable?: boolean
  selecting: boolean
  onOpen: (asset: TileSubject) => void
  onToggleSelect: (asset: TileSubject, shiftKey: boolean) => void
}

/**
 * What to call a photograph out loud.
 *
 * A tile has no filename, so it is named by the moment it was taken — to the second, because
 * a day's worth of tiles named only by their day would be a screen full of buttons a screen
 * reader cannot tell apart, and the grid is nothing but buttons.
 */
function nameOf(asset: TileSubject): string {
  if ('originalFilename' in asset) return asset.originalFilename
  return `photo taken ${formatCaptureMoment(asset.capturedAt)}`
}

/**
 * A tile paints the photograph's own dominant colour before the image arrives, so a
 * library scrolled cold shows a mosaic of true colours resolving into pictures rather
 * than a field of grey rectangles. The colour is computed once at ingest; this is just
 * showing what we already know.
 *
 * The image fades in with a CSS animation rather than a JS `loaded` flag. Gating
 * visibility on an onLoad handler loses the race whenever the browser finishes the
 * image before React attaches the listener, and the photo then never appears at all.
 */
export function PhotoTile({
  asset,
  width,
  height,
  selected,
  selecting,
  selectable = true,
  onOpen,
  onToggleSelect,
}: Props) {
  const urls = useAssetUrls()
  const pending = asset.status !== 'ready'

  return (
    <div
      className="group relative shrink-0 overflow-hidden rounded-[--radius-tile]"
      style={{ width, height, background: asset.placeholderColor ?? 'var(--color-sunken)' }}
    >
      {!pending && (
        <img
          src={urls.url(asset.id, 'thumbnail')}
          alt={('description' in asset ? asset.description : null) ?? nameOf(asset)}
          width={width}
          height={height}
          loading="lazy"
          decoding="async"
          className="tile-image h-full w-full object-cover"
        />
      )}

      {pending && (
        <div className="absolute inset-0 grid place-items-center">
          <span className="label-micro text-white/80 mix-blend-difference">
            {asset.status === 'failed' ? 'Unreadable' : 'Processing'}
          </span>
        </div>
      )}

      {/* The whole tile is the control. A separate hit area would be a lie about what is clickable. */}
      <button
        type="button"
        onClick={(event) => {
          if (selectable && (selecting || event.metaKey || event.ctrlKey)) {
            onToggleSelect(asset, event.shiftKey)
            return
          } else onOpen(asset)
        }}
        aria-label={`Open ${nameOf(asset)}`}
        className="absolute inset-0 cursor-pointer"
      />

      {asset.type === 'video' && !pending && (
        <>
          <span className="pointer-events-none absolute inset-0 grid place-items-center">
            <span className="grid h-9 w-9 place-items-center rounded-full bg-black/45 ring-1 ring-white/25 backdrop-blur-sm transition-transform duration-200 group-hover:scale-110">
              <svg
                aria-hidden="true"
                viewBox="0 0 24 24"
                className="ml-0.5 h-4 w-4 fill-white drop-shadow"
              >
                <path d="M8 5.5v13l11-6.5z" />
              </svg>
            </span>
          </span>
          {asset.duration !== null && (
            <span className="pointer-events-none absolute right-1.5 bottom-1.5 rounded bg-black/55 px-1.5 py-0.5 font-mono text-[11px] text-white tabular-nums backdrop-blur-sm">
              {formatDuration(asset.duration)}
            </span>
          )}
        </>
      )}

      {asset.favorite && !selected && (
        <svg
          viewBox="0 0 24 24"
          aria-hidden="true"
          className="pointer-events-none absolute bottom-1.5 left-1.5 h-4 w-4 fill-white drop-shadow-[0_1px_2px_rgba(0,0,0,0.6)]"
        >
          <path d="M12 20.3 4.6 13a4.6 4.6 0 0 1 6.5-6.5l.9.9.9-.9A4.6 4.6 0 0 1 19.4 13Z" />
        </svg>
      )}

      {/* The selection affordance appears on hover, and stays once anything is selected. */}
      {selectable && (
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation()
            onToggleSelect(asset, event.shiftKey)
          }}
          aria-label={selected ? 'Deselect' : 'Select'}
          aria-pressed={selected}
          className={`absolute left-1.5 top-1.5 grid h-6 w-6 place-items-center rounded-full border transition-all ${
            selected
              ? 'border-safelight bg-safelight text-white'
              : 'border-white/70 bg-black/25 text-transparent opacity-0 backdrop-blur-sm group-hover:opacity-100 focus-visible:opacity-100'
          } ${selecting ? 'opacity-100' : ''}`}
        >
          <svg viewBox="0 0 20 20" aria-hidden="true" className="h-3.5 w-3.5">
            <path
              d="M4 10.5l4 4 8-9"
              fill="none"
              stroke={selected ? 'currentColor' : 'white'}
              strokeWidth="2.4"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>
      )}

      {selected && (
        <span className="pointer-events-none absolute inset-0 rounded-[--radius-tile] ring-2 ring-safelight ring-inset" />
      )}
    </div>
  )
}
