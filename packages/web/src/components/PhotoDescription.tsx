import type { Asset } from '@imogen/shared'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { imogen } from '../lib/client.ts'

/** Matches the limit the API enforces, so the field stops before the request fails. */
const MAX_LENGTH = 4096

/**
 * Query keys whose data holds assets, and so goes stale when a description changes.
 *
 * `asset` is the whole photograph the viewer fetches for itself, which is where a description
 * is read and written. `album` and `person` carry whole assets too, and their grids draw the
 * description as an image's alt text. The timeline's own tiles do not carry one — and since a
 * description changes no day's count, the windowed grid will not refetch the month for it
 * either; there is simply nothing on a timeline tile for this to make stale.
 */
const ASSET_QUERIES = new Set(['assets', 'album', 'person', 'vault-assets', 'timeline', 'asset'])

/**
 * What the photograph is of, in the owner's own words.
 *
 * Offered as an empty invitation rather than appearing only once something has been
 * written: a description nobody can see the way to add is a description nobody adds.
 * Descriptions are weighted above camera and place in search, so this is the most
 * direct way to make a photo findable later.
 */
export function PhotoDescription({ asset, editable }: { asset: Asset; editable: boolean }) {
  const queryClient = useQueryClient()
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')

  const save = useMutation({
    mutationFn: (value: string) =>
      imogen.assets.update(asset.id, { description: value.trim() || null }),
    onSuccess: () => {
      setEditing(false)
      void queryClient.invalidateQueries({
        predicate: (query) => ASSET_QUERIES.has(query.queryKey[0] as string),
      })
    },
  })

  // A shared album is someone else's photograph: show the words, never the pencil.
  if (!editable) {
    if (!asset.description) return null
    return (
      <Section>
        <p className="text-sm leading-relaxed text-white/80">{asset.description}</p>
      </Section>
    )
  }

  if (editing) {
    return (
      <Section>
        <textarea
          ref={(node) => node?.focus()}
          value={draft}
          maxLength={MAX_LENGTH}
          rows={4}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Escape') setEditing(false)
            // Enter belongs to the paragraph, so the shortcut that saves is the one
            // every other multi-line field uses.
            if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
              save.mutate(draft)
            }
          }}
          placeholder="What is happening here?"
          className="w-full resize-y rounded-md border border-white/20 bg-white/10 px-2.5 py-2 text-sm leading-relaxed text-white outline-none placeholder:text-white/40 focus:border-safelight"
        />
        <div className="mt-2 flex items-center gap-2">
          <button
            type="button"
            onClick={() => save.mutate(draft)}
            disabled={save.isPending}
            className="rounded-md bg-white/15 px-2.5 py-1 text-xs text-white transition hover:bg-white/25 disabled:opacity-50"
          >
            {save.isPending ? 'Saving' : 'Save'}
          </button>
          <button
            type="button"
            onClick={() => setEditing(false)}
            className="px-1 text-xs text-white/50 transition hover:text-white"
          >
            Cancel
          </button>
          {save.isError && <span className="text-xs text-red-300">Could not save</span>}
        </div>
      </Section>
    )
  }

  const start = () => {
    setDraft(asset.description ?? '')
    setEditing(true)
  }

  if (!asset.description) {
    return (
      <Section>
        <button
          type="button"
          onClick={start}
          className="w-full rounded-md border border-dashed border-white/25 px-2.5 py-2 text-left text-sm text-white/50 transition hover:border-white/50 hover:text-white"
        >
          Add a description
        </button>
      </Section>
    )
  }

  return (
    <Section>
      <button
        type="button"
        onClick={start}
        className="w-full rounded-md px-0.5 text-left text-sm leading-relaxed text-white/80 transition hover:text-white"
      >
        {asset.description}
      </button>
    </Section>
  )
}

function Section({ children }: { children: React.ReactNode }) {
  return (
    <div className="mt-6 border-t border-white/10 pt-5">
      <h3 className="label-micro mb-3 text-white/45">Description</h3>
      {children}
    </div>
  )
}
