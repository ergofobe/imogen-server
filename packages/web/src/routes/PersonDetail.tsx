import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useMemo, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router'
import { TimelineBody, TimelineCount } from '../components/TimelineBody.tsx'
import { TimelineSkeleton } from '../components/TimelineSkeleton.tsx'
import { Viewer } from '../components/Viewer.tsx'
import { useOverviewKey } from '../hooks/useOverviewKey.ts'
import { useTimelineGrid } from '../hooks/useTimelineGrid.ts'
import { useTimelineViewer } from '../hooks/useTimelineViewer.ts'
import { imogen } from '../lib/client.ts'

export function PersonDetail() {
  const { id = '' } = useParams()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const [editing, setEditing] = useState(false)
  const [name, setName] = useState('')

  const { data: person, isPending } = useQuery({
    queryKey: ['person', id],
    queryFn: () => imogen.people.get(id),
  })

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

  /*
   * The timeline under `{ personId }`, not `person.photos`.
   *
   * `people.get` answers with a capped sample, the same shape and the same sixty as an
   * album's. Reading a grid from it showed sixty photographs of somebody who appears in
   * six hundred, with nothing on the page to say so and no way to reach the rest.
   */
  const filter = useMemo(() => ({ personId: id }), [id])
  const grid = useTimelineGrid(filter)
  const viewer = useTimelineViewer(grid)
  useOverviewKey(grid, viewer.openId)

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ['person', id] })
    void queryClient.invalidateQueries({ queryKey: ['people'] })
    void queryClient.invalidateQueries({ queryKey: ['asset'] })
    grid.reload()
  }

  if (isPending || !person) return <TimelineSkeleton />

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
            <TimelineCount
              totalCount={grid.totalCount}
              onShowOverview={() => grid.setShowingOverview(true)}
            />
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

      <TimelineBody
        grid={grid}
        filter={filter}
        empty={{
          headline: 'No photos to show',
          body: 'Every photo this person appeared in has been vaulted or deleted.',
        }}
        onOpen={(tile) => viewer.open(tile.id)}
      />

      {viewer.asset && (
        <Viewer
          asset={viewer.asset}
          hasPrevious={viewer.hasPrevious}
          hasNext={viewer.hasNext}
          onClose={viewer.close}
          onPrevious={() => viewer.step(-1)}
          onNext={() => viewer.step(1)}
          onToggleFavorite={(asset) => {
            void imogen.assets.update(asset.id, { favorite: !asset.favorite }).then(refresh)
          }}
          onTrash={(asset) => {
            viewer.close()
            void imogen.assets.trash({ assetIds: [asset.id] }).then(refresh)
          }}
        />
      )}
    </>
  )
}
