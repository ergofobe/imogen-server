import type { BulkUploadResult } from '@imogen/sdk'
import { useQueryClient } from '@tanstack/react-query'
import { useCallback, useEffect, useRef, useState } from 'react'
import { imogen } from '../lib/client.ts'

type Item = {
  /** Stable across re-renders: two selected files can share a name. */
  key: string
  name: string
  state: 'waiting' | 'uploading' | 'done' | 'duplicate' | 'failed'
  error?: string
}

/**
 * Uploading is the one thing a photo library must never make you babysit. Files are
 * queued, uploaded a few at a time, and each one reports on itself — so a folder of
 * three thousand photos shows progress rather than a spinner, and a single unreadable
 * file does not take the batch down with it.
 */
export function UploadDrawer({ open, onClose }: { open: boolean; onClose: () => void }) {
  const queryClient = useQueryClient()
  const inputRef = useRef<HTMLInputElement>(null)
  const [items, setItems] = useState<Item[]>([])
  const [busy, setBusy] = useState(false)
  const [dragging, setDragging] = useState(false)

  const upload = useCallback(
    async (files: File[]) => {
      if (files.length === 0) return
      setBusy(true)
      setItems(
        files.map((file, i) => ({ key: `${i}-${file.name}`, name: file.name, state: 'waiting' })),
      )

      const byName = new Map(files.map((file, index) => [file, index]))
      await imogen.assets.uploadMany(files, {
        onFileComplete: (outcome: BulkUploadResult) => {
          const index = byName.get(outcome.file)
          if (index === undefined) return
          setItems((current) => {
            const next = [...current]
            next[index] = {
              key: `${index}-${outcome.file.name}`,
              name: outcome.file.name,
              state: outcome.error ? 'failed' : outcome.result?.duplicate ? 'duplicate' : 'done',
              ...(outcome.error ? { error: outcome.error.message } : {}),
            }
            return next
          })
        },
      })

      setBusy(false)
      // The timeline spine is what sizes the grid, and its tile map follows the spine, so a
      // photograph uploaded while the timeline is open appears without leaving the page.
      void queryClient.invalidateQueries({ queryKey: ['assets'] })
      void queryClient.invalidateQueries({ queryKey: ['timeline'] })
    },
    [queryClient],
  )

  // Drop anywhere on the page, which is what people try first.
  useEffect(() => {
    if (!open) return
    const prevent = (event: DragEvent) => {
      event.preventDefault()
      setDragging(true)
    }
    const leave = () => setDragging(false)
    const drop = (event: DragEvent) => {
      event.preventDefault()
      setDragging(false)
      const files = [...(event.dataTransfer?.files ?? [])]
      if (files.length > 0) void upload(files)
    }
    window.addEventListener('dragover', prevent)
    window.addEventListener('dragleave', leave)
    window.addEventListener('drop', drop)
    return () => {
      window.removeEventListener('dragover', prevent)
      window.removeEventListener('dragleave', leave)
      window.removeEventListener('drop', drop)
    }
  }, [open, upload])

  if (!open) return null

  const done = items.filter((i) => i.state !== 'waiting' && i.state !== 'uploading').length
  const failed = items.filter((i) => i.state === 'failed')

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Add photos"
      className="fixed inset-0 z-50 grid place-items-end sm:place-items-center"
    >
      <button
        type="button"
        aria-label="Close"
        onClick={busy ? undefined : onClose}
        className="absolute inset-0 bg-black/40 backdrop-blur-[2px]"
      />

      <div className="surface-panel relative w-full max-w-lg rounded-t-2xl p-5 sm:rounded-2xl">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="heading-display text-lg">Add photos</h2>
          {!busy && (
            <button
              type="button"
              onClick={onClose}
              aria-label="Close"
              className="grid h-8 w-8 place-items-center rounded-full text-muted hover:bg-sunken hover:text-ink"
            >
              <svg
                aria-hidden="true"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.7"
                strokeLinecap="round"
                className="h-4 w-4"
              >
                <path d="M6 6l12 12M18 6L6 18" />
              </svg>
            </button>
          )}
        </div>

        {items.length === 0 ? (
          <>
            <button
              type="button"
              onClick={() => inputRef.current?.click()}
              className={`flex w-full flex-col items-center gap-2 rounded-xl border border-dashed px-6 py-12 transition ${
                dragging ? 'border-safelight bg-sunken' : 'border-line hover:bg-sunken/60'
              }`}
            >
              <svg
                aria-hidden="true"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
                className="h-7 w-7 text-muted"
              >
                <path d="M12 16V4m0 0 4 4m-4-4L8 8M4 17v2a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-2" />
              </svg>
              <span className="text-sm font-medium">Choose files or drop them here</span>
              <span className="text-xs text-muted">
                Photos and video. HEIC and RAW are welcome.
              </span>
            </button>
            <input
              ref={inputRef}
              type="file"
              multiple
              accept="image/*,video/*,.heic,.heif,.cr2,.cr3,.nef,.arw,.dng,.orf,.raf,.rw2"
              onChange={(event) => {
                const files = [...(event.target.files ?? [])]
                if (files.length > 0) void upload(files)
              }}
              className="hidden"
            />
          </>
        ) : (
          <>
            <div className="mb-3 flex items-baseline justify-between">
              <span className="label-micro">
                {done} of {items.length}
              </span>
              {!busy && (
                <button
                  type="button"
                  onClick={() => setItems([])}
                  className="text-sm text-muted underline-offset-4 hover:text-ink hover:underline"
                >
                  Add more
                </button>
              )}
            </div>

            <div
              className="mb-4 h-1 overflow-hidden rounded-full bg-sunken"
              role="progressbar"
              aria-valuenow={done}
              aria-valuemin={0}
              aria-valuemax={items.length}
            >
              <div
                className="h-full bg-safelight transition-[width] duration-300"
                style={{ width: `${(done / items.length) * 100}%` }}
              />
            </div>

            <ul className="max-h-64 space-y-1.5 overflow-y-auto">
              {items.map((item) => (
                <li key={item.key} className="flex items-center gap-2.5 text-sm">
                  <StateDot state={item.state} />
                  <span className="min-w-0 flex-1 truncate">{item.name}</span>
                  {item.state === 'duplicate' && (
                    <span className="label-micro shrink-0">Already here</span>
                  )}
                  {item.state === 'failed' && (
                    <span className="shrink-0 text-xs text-safelight">Skipped</span>
                  )}
                </li>
              ))}
            </ul>

            {!busy && failed.length > 0 && (
              <p className="mt-4 border-t border-line pt-4 text-xs leading-relaxed text-muted">
                {failed.length} {failed.length === 1 ? 'file was' : 'files were'} skipped:{' '}
                {failed[0]!.error ?? 'unsupported format'}
              </p>
            )}

            {!busy && (
              <button
                type="button"
                onClick={onClose}
                className="mt-4 w-full rounded-lg bg-ink py-2.5 text-sm font-medium text-paper transition hover:opacity-90"
              >
                Done
              </button>
            )}
          </>
        )}
      </div>
    </div>
  )
}

function StateDot({ state }: { state: Item['state'] }) {
  if (state === 'done' || state === 'duplicate') {
    return (
      <svg viewBox="0 0 20 20" aria-hidden="true" className="h-4 w-4 shrink-0 text-muted">
        <path
          d="M4 10.5l4 4 8-9"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    )
  }
  if (state === 'failed') {
    return (
      <svg viewBox="0 0 20 20" aria-hidden="true" className="h-4 w-4 shrink-0 text-safelight">
        <path
          d="M5 5l10 10M15 5L5 15"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.2"
          strokeLinecap="round"
        />
      </svg>
    )
  }
  return <span aria-hidden="true" className="h-2 w-2 shrink-0 animate-pulse rounded-full bg-line" />
}
