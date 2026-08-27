import type { AssetSelection } from '@imogen/shared'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { imogen } from '../lib/client.ts'

/**
 * Choosing where a handful of selected photographs should go.
 *
 * Existing albums and a new one are offered together. Wanting a new album is not a
 * different intention from wanting an old one — it is the same act, and sending
 * somebody to the Albums page to make one first loses the selection they came with.
 *
 * The result says how many were already there. Adding forty photographs and being
 * told "added 12" with no explanation reads as a failure rather than as the album
 * already holding the rest.
 */
export function AlbumPicker({
  selection,
  count,
  onClose,
  onDone,
}: {
  /** Either the ids, or the filter the reader was looking at minus what they unticked. */
  selection: AssetSelection
  /** Resolved against the whole filter, so the heading is a number under select-all too. */
  count: number
  onClose: () => void
  onDone: (message: string) => void
}) {
  const queryClient = useQueryClient()
  const [name, setName] = useState('')
  const [filter, setFilter] = useState('')

  const { data: albums, isPending } = useQuery({
    queryKey: ['albums'],
    queryFn: () => imogen.albums.list(),
  })

  const finish = (added: number, skipped: number, album: string) => {
    void queryClient.invalidateQueries({ queryKey: ['albums'] })
    void queryClient.invalidateQueries({ queryKey: ['album'] })
    onDone(
      skipped > 0
        ? `Added ${added} to ${album}. ${skipped} ${skipped === 1 ? 'was' : 'were'} already there.`
        : `Added ${added} to ${album}.`,
    )
  }

  const addToExisting = useMutation({
    mutationFn: (album: { id: string; name: string }) =>
      imogen.albums.addAssets(album.id, selection).then((result) => ({ result, album })),
    onSuccess: ({ result, album }) => finish(result.added, result.skipped, album.name),
  })

  /*
   * Two calls rather than one. `POST /albums` takes an id list and nothing else, so a
   * select-all cannot be expressed in it — the album is made empty and then filled through
   * the endpoint that does understand a filter. The alternative was resolving the filter to
   * ids in the browser, which is the request this whole selection shape exists to avoid.
   */
  const createWith = useMutation({
    mutationFn: async () => {
      const album = await imogen.albums.create({ name: name.trim() })
      const result = await imogen.albums.addAssets(album.id, selection)
      return { album, result }
    },
    onSuccess: ({ album, result }) => finish(result.added, result.skipped, album.name),
  })

  // Escape closes, like every other transient thing in this app.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const busy = addToExisting.isPending || createWith.isPending
  const matching = albums?.filter((album) =>
    album.name.toLowerCase().includes(filter.trim().toLowerCase()),
  )

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/40 p-4 backdrop-blur-sm">
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Add to an album"
        className="surface-panel flex max-h-[min(32rem,80dvh)] w-full max-w-md flex-col rounded-xl p-4"
      >
        <div className="mb-3 flex items-baseline justify-between gap-3">
          <h2 className="heading-display text-base">
            Add {count.toLocaleString()} {count === 1 ? 'photo' : 'photos'} to
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="text-sm text-muted underline-offset-4 hover:text-ink hover:underline"
          >
            Cancel
          </button>
        </div>

        <form
          onSubmit={(event) => {
            event.preventDefault()
            if (name.trim()) createWith.mutate()
          }}
          className="mb-3 flex items-center gap-2"
        >
          <input
            ref={(node) => node?.focus()}
            value={name}
            onChange={(event) => {
              setName(event.target.value)
              setFilter(event.target.value)
            }}
            placeholder="A new album, or find one"
            className="min-w-0 flex-1 rounded-lg border border-line bg-paper px-3 py-1.5 text-sm outline-none focus:border-safelight"
          />
          <button
            type="submit"
            disabled={!name.trim() || busy}
            className="shrink-0 rounded-lg bg-ink px-3 py-1.5 text-sm text-paper transition hover:opacity-90 disabled:opacity-40"
          >
            Create
          </button>
        </form>

        <div className="min-h-0 flex-1 overflow-y-auto">
          {isPending ? (
            <div className="h-24 animate-pulse rounded-lg bg-sunken" />
          ) : matching && matching.length > 0 ? (
            <ul className="space-y-1">
              {matching.map((album) => (
                <li key={album.id}>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => addToExisting.mutate({ id: album.id, name: album.name })}
                    className="flex w-full items-baseline justify-between gap-3 rounded-lg px-3 py-2 text-left transition hover:bg-sunken disabled:opacity-50"
                  >
                    <span className="truncate text-sm">{album.name}</span>
                    <span className="label-micro shrink-0 text-[10px] text-muted">
                      {album.assetCount}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="px-3 py-6 text-center text-sm text-muted">
              {filter.trim()
                ? 'No album by that name. Create is right there.'
                : 'No albums yet. Type a name to make the first one.'}
            </p>
          )}
        </div>

        {(addToExisting.isError || createWith.isError) && (
          <p className="mt-3 text-sm text-red-500">
            {(addToExisting.error ?? createWith.error) instanceof Error
              ? (addToExisting.error ?? createWith.error)?.message
              : 'That did not work'}
          </p>
        )}
      </div>
    </div>
  )
}
