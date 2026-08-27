import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useMemo, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router'
import { EmptyState } from '../components/EmptyState.tsx'
import { PhotoGrid } from '../components/PhotoGrid.tsx'
import { Viewer } from '../components/Viewer.tsx'
import { useGridLayout } from '../hooks/useGridLayout.ts'
import { useAssetTable } from '../hooks/useTimeline.ts'
import { useViewerParam } from '../hooks/useViewerParam.ts'
import { imogen } from '../lib/client.ts'

/** A page with no selection still needs one object rather than a new Set every render. */
const EMPTY_SELECTION = new Set<string>()

export function PersonDetail() {
  const { id = '' } = useParams()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const { openId, open: openPhoto, replace: showPhoto, close: closePhoto } = useViewerParam()
  const [editing, setEditing] = useState(false)
  const [name, setName] = useState('')

  const { data: person, isPending } = useQuery({
    queryKey: ['person', id],
    queryFn: () => imogen.people.get(id),
  })

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ['person', id] })
    void queryClient.invalidateQueries({ queryKey: ['people'] })
  }

  const rename = useMutation({
    mutationFn: (value: string | null) => imogen.people.update(id, { name: value }),
    onSuccess: () => {
      setEditing(false)
      refresh()
    },
  })

  const hide = useMutation({
    mutationFn: () => imogen.people.update(id, { hidden: true }),
    onSuccess: () => {
      refresh()
      navigate('/people')
    },
  })

  const { containerRef, options } = useGridLayout()
  const photos = useMemo(() => person?.photos ?? [], [person])
  const { table, tiles } = useAssetTable(photos, options)

  if (isPending || !person) return <div className="h-40 animate-pulse rounded-lg bg-sunken" />
  const openIndex = openId ? photos.findIndex((p) => p.id === openId) : -1

  return (
    <>
      <Link
        to="/people"
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
        People
      </Link>

      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          {person.coverFaceId && (
            <img
              src={`/api/v1/people/thumbnail/${person.coverFaceId}`}
              alt=""
              className="h-12 w-12 rounded-full object-cover"
            />
          )}
          <div>
            {editing ? (
              <form
                onSubmit={(event) => {
                  event.preventDefault()
                  rename.mutate(name.trim() || null)
                }}
                className="flex items-center gap-2"
              >
                <input
                  ref={(node) => node?.focus()}
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  placeholder="Their name"
                  className="rounded-lg border border-line bg-surface px-3 py-1.5 text-sm outline-none focus:border-safelight"
                />
                <button
                  type="submit"
                  className="rounded-lg bg-ink px-3 py-1.5 text-sm font-medium text-paper"
                >
                  Save
                </button>
                <button
                  type="button"
                  onClick={() => setEditing(false)}
                  className="text-sm text-muted hover:text-ink"
                >
                  Cancel
                </button>
              </form>
            ) : (
              <button
                type="button"
                onClick={() => {
                  setName(person.name ?? '')
                  setEditing(true)
                }}
                className="heading-display text-left text-2xl hover:text-safelight md:text-[28px]"
              >
                {person.name ?? <span className="text-muted italic">Add a name</span>}
              </button>
            )}
            <p className="label-micro mt-1">
              {person.photoCount} {person.photoCount === 1 ? 'photo' : 'photos'}
            </p>
          </div>
        </div>

        <button
          type="button"
          onClick={() => hide.mutate()}
          className="rounded-lg px-3 py-1.5 text-sm text-muted transition hover:text-ink"
        >
          Hide this person
        </button>
      </div>

      {photos.length === 0 ? (
        <EmptyState
          headline="No photos to show"
          body="Every photo this person appeared in has been vaulted or deleted."
        />
      ) : (
        <PhotoGrid
          table={table}
          tiles={tiles}
          options={options}
          containerRef={containerRef}
          selected={EMPTY_SELECTION}
          onOpen={(tile) => openPhoto(tile.id)}
          onToggleSelect={() => {}}
        />
      )}

      {openIndex >= 0 && photos[openIndex] && (
        <Viewer
          asset={photos[openIndex]}
          hasPrevious={openIndex > 0}
          hasNext={openIndex < photos.length - 1}
          onClose={closePhoto}
          onPrevious={() => showPhoto(photos[openIndex - 1]?.id ?? '')}
          onNext={() => showPhoto(photos[openIndex + 1]?.id ?? '')}
          onToggleFavorite={(asset) => {
            void imogen.assets.update(asset.id, { favorite: !asset.favorite }).then(refresh)
          }}
          onTrash={(asset) => {
            closePhoto()
            void imogen.assets.trash([asset.id]).then(refresh)
          }}
        />
      )}
    </>
  )
}
