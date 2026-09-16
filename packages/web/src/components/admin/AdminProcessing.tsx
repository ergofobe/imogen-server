import type { AdminJob } from '@imogen/shared'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { imogen } from '../../lib/client.ts'

/**
 * The background pipeline, and what it gave up on.
 *
 * Until this existed a failed transcode left a photograph saying "processing" for
 * ever, with the reason written to a column nothing ever read. The error text is the
 * point of the page, so it is shown in full rather than behind a chevron.
 */
export function AdminProcessing() {
  const queryClient = useQueryClient()
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['admin', 'queue'] })

  const { data, isPending, isError, error, refetch, isFetching } = useQuery({
    queryKey: ['admin', 'queue'],
    queryFn: () => imogen.admin.queue(),
    // Work in flight moves; a still queue costs one request a minute.
    refetchInterval: (query) =>
      (query.state.data?.queued ?? 0) + (query.state.data?.running ?? 0) > 0 ? 3000 : 60_000,
    // No retry, against the default of three. When the server cannot reach its database
    // the request takes the full backstop to fail, and three of those in series would
    // keep this panel silent for minutes — which is precisely the failure it exists to
    // report. Nothing is lost by reporting at once, because the failure is not a dead
    // end: the interval above goes on asking, and the panel offers a button besides.
    retry: false,
  })

  const retryAll = useMutation({
    mutationFn: () => imogen.admin.retryAllJobs(),
    onSuccess: refresh,
  })

  if (isPending) return <div className="h-40 animate-pulse rounded-xl bg-sunken" />

  // A skeleton here would be a lie: this panel is the only place a stalled pipeline shows
  // up, so when it cannot be read it has to say so rather than go on pulsing. See #71.
  if (isError || !data) {
    return (
      <section className="rounded-xl border border-red-500/40 p-4">
        <h2 className="heading-display text-xl">Processing</h2>
        <p className="mt-1 text-sm text-red-500">
          The queue could not be read, so there is no telling whether photographs are being worked
          through.
        </p>
        <pre className="mt-3 overflow-x-auto rounded-lg bg-sunken p-3 font-mono text-[12px] leading-relaxed text-muted">
          {errorText(error)}
        </pre>
        <button
          type="button"
          onClick={() => void refetch()}
          disabled={isFetching}
          className="mt-3 rounded-lg border border-line px-3 py-1.5 text-sm transition hover:bg-sunken disabled:opacity-50"
        >
          {isFetching ? 'Asking' : 'Try again'}
        </button>
      </section>
    )
  }

  return (
    <div className="space-y-8">
      <section>
        <header className="mb-4">
          <h2 className="heading-display text-xl">Processing</h2>
          <p className="mt-1 text-sm text-muted">
            {data.queued + data.running === 0
              ? 'Nothing is waiting.'
              : 'Photographs are being worked through.'}
          </p>
        </header>

        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Tile label="Waiting" value={data.queued} />
          <Tile label="Running" value={data.running} />
          <Tile label="Failed" value={data.failed} tone={data.failed > 0 ? 'bad' : undefined} />
          <Tile
            label="Unfinished photos"
            value={data.stuck}
            tone={data.stuck > 0 ? 'warn' : undefined}
          />
        </div>

        {data.oldestQueuedAt && (
          <p className="mt-3 text-sm text-muted">
            The oldest thing still waiting arrived {new Date(data.oldestQueuedAt).toLocaleString()}.
          </p>
        )}
      </section>

      <section>
        <header className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <div>
            <h3 className="heading-display text-lg">Failures</h3>
            <p className="mt-1 text-sm text-muted">
              {data.failures.length === 0
                ? 'Nothing has been given up on.'
                : 'Each of these stopped after using up its attempts.'}
            </p>
          </div>
          {data.failures.length > 0 && (
            <button
              type="button"
              onClick={() => retryAll.mutate()}
              disabled={retryAll.isPending}
              className="rounded-lg border border-line px-3 py-1.5 text-sm transition hover:bg-sunken disabled:opacity-50"
            >
              {retryAll.isPending ? 'Retrying' : 'Retry all'}
            </button>
          )}
        </header>

        <ul className="space-y-2">
          {data.failures.map((job) => (
            <FailureRow key={job.id} job={job} onChanged={refresh} />
          ))}
        </ul>
      </section>

      <Repairs onStarted={refresh} />
    </div>
  )
}

/** One repair pass, as `GET /api/v1/admin/repairs` describes it. */
type Repair = {
  name: string
  title: string
  description: string
  candidates: number
  state: 'idle' | 'running' | 'done'
}

/**
 * Repairs of values stored before a defect was fixed.
 *
 * Deliberately a button rather than something an upgrade does on its own: each of these
 * rewrites stored values across every account with no undo, and a version bump should not
 * silently move every capture time in somebody's library. The count is shown first so the
 * decision is made against a number.
 *
 * Asked for through `imogen.http` rather than a typed `imogen.admin` method: a method
 * belongs in the SDK, and adding one there would make this a cross-repo change with a
 * submodule pin to move, which #54's triage ruled out for now. This is still the SDK's own
 * client — the session cookie, the base URL and `ImogenError` all come with it — not a
 * hand-rolled fetch. When repairs grow an MCP surface they grow a typed method with it.
 */
function Repairs({ onStarted }: { onStarted: () => void }) {
  const queryClient = useQueryClient()

  const { data, isPending, isError, error, refetch, isFetching } = useQuery({
    queryKey: ['admin', 'repairs'],
    queryFn: () => imogen.http.request<{ items: Repair[] }>('GET', '/api/v1/admin/repairs'),
    refetchInterval: (query) => repairsPollInterval(query.state),
    // No retry, for the reason the queue above gives. What made that a dead end here was
    // the interval, not this: see `repairsPollInterval`.
    retry: false,
  })

  const start = useMutation({
    mutationFn: (name: string) =>
      imogen.http.request<void>('POST', `/api/v1/admin/repairs/${name}`),
    // `onSettled`, not `onSuccess`: this POST is not idempotent and the SDK retries a
    // transient failure, so a start whose response was lost comes back as the guard's own
    // 409. Asking again is what tells the admin the truth — the pass is running — however
    // the request appeared to end.
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: ['admin', 'repairs'] })
      onStarted()
    },
  })

  if (isPending) return null

  // Every failure is reported: this section can be the only sign that a pass is walking
  // the library, and #89 had it disappear on a single transient 500 with nothing said and
  // nothing asking again. The one silence left is having no repairs to offer.
  //
  // Not even a 404 is excused, tempting as it is to read one as "this server is too old
  // to have the route". The admin API refuses everything with a plain 404 on purpose — it
  // is meant to be undiscoverable rather than merely closed — so an expired session
  // arrives as the same status, and excusing it would leave a stale list on screen with
  // "Walking the library" still showing and nothing asking again.
  const failure = isError ? errorText(error) : null
  const items = data?.items ?? []
  if (!failure && items.length === 0) return null

  return (
    <section>
      <header className="mb-4">
        <h3 className="heading-display text-lg">Repairs</h3>
        <p className="mt-1 text-sm text-muted">
          One-off passes over photographs stored before a defect was fixed. None of them run on
          their own.
        </p>
      </header>

      {/*
        A banner over the list rather than instead of it. React Query keeps the last good
        answer through an error, and this only polls while a pass is walking — so replacing
        the list would blank the running row and the buttons on every blip in the
        fifteen-second cadence and restore them on the next. The failure is the news; what
        was already known is still worth showing.
      */}
      {failure && (
        <div className="mb-4 rounded-xl border border-red-500/40 p-4">
          <p className="text-sm text-red-500">
            The repairs could not be read, so there is no telling whether one is walking the
            library.
          </p>
          <pre className="mt-3 overflow-x-auto rounded-lg bg-sunken p-3 font-mono text-[12px] leading-relaxed text-muted">
            {failure}
          </pre>
          <button
            type="button"
            onClick={() => void refetch()}
            disabled={isFetching}
            className="mt-3 rounded-lg border border-line px-3 py-1.5 text-sm transition hover:bg-sunken disabled:opacity-50"
          >
            {isFetching ? 'Asking' : 'Try again'}
          </button>
        </div>
      )}

      <ul className="space-y-2">
        {items.map((repair) => (
          <li key={repair.name} className="rounded-xl border border-line p-4">
            <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
              <p className="text-sm">{repair.title}</p>
              <p className="label-micro text-[10px] text-muted">
                {repair.candidates.toLocaleString()} to examine
                {repair.state === 'done' ? ' · already run' : ''}
              </p>
            </div>

            <p className="mt-2 text-sm text-muted">{repair.description}</p>

            <button
              type="button"
              onClick={() => start.mutate(repair.name)}
              disabled={
                (start.isPending && start.variables === repair.name) ||
                repair.state === 'running' ||
                repair.candidates === 0
              }
              className="mt-3 rounded-lg border border-line px-3 py-1.5 text-sm transition hover:bg-sunken disabled:opacity-50"
            >
              {repair.state === 'running' ? 'Walking the library' : 'Start'}
            </button>
          </li>
        ))}
      </ul>

      {start.isError && <p className="mt-3 text-sm text-red-500">{errorText(start.error)}</p>}
    </section>
  )
}

/**
 * How long until the repairs list is asked again, or `false` to stop asking.
 *
 * Exported because this function *is* #89. It used to read `data` alone: after a failed
 * poll `data` is undefined, so it returned `false`, and with `retry: false` above nothing
 * ever asked again — one transient 500 left the query errored for the life of the page.
 * A failure therefore gets the same cadence a running pass gets, so the panel heals on
 * its own for an administrator who has walked away from the tab.
 *
 * A quiet list is still not polled. What the interval waits for is a pass finishing — the
 * state going back to `done` and the button returning — not the count, which for the
 * capture-time pass never falls: a repaired row still matches its own predicate, which is
 * exactly what makes the pass safe to run twice. Progress belongs to the queue panel
 * above. Each answer costs a count over every asset, and the orientation one reads a JSON
 * field no index can serve, so asking every three seconds for the hours a large library
 * takes would only contend with the walk's own reads.
 */
export function repairsPollInterval(state: {
  status: 'pending' | 'error' | 'success'
  data: { items: Repair[] } | undefined
}): number | false {
  if (state.status === 'error') return REPAIRS_POLL_MS
  return state.data?.items.some((repair) => repair.state === 'running') ? REPAIRS_POLL_MS : false
}

const REPAIRS_POLL_MS = 15_000

function FailureRow({ job, onChanged }: { job: AdminJob; onChanged: () => void }) {
  const retry = useMutation({
    mutationFn: () => imogen.admin.retryJob(job.id),
    onSuccess: onChanged,
  })
  const discard = useMutation({
    mutationFn: () => imogen.admin.discardJob(job.id),
    onSuccess: onChanged,
  })
  const busy = retry.isPending || discard.isPending

  return (
    <li className="rounded-xl border border-line p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <p className="font-mono text-[13px]">{job.name}</p>
        <p className="label-micro text-[10px] text-muted">
          {job.attempts} of {job.maxAttempts} attempts · {new Date(job.createdAt).toLocaleString()}
        </p>
      </div>

      {job.lastError && (
        <pre className="mt-2 overflow-x-auto rounded-lg bg-sunken p-3 font-mono text-[12px] leading-relaxed text-muted">
          {job.lastError}
        </pre>
      )}

      <div className="mt-3 flex flex-wrap gap-2">
        <button
          type="button"
          onClick={() => retry.mutate()}
          disabled={busy}
          className="rounded-lg border border-line px-3 py-1.5 text-sm transition hover:bg-sunken disabled:opacity-50"
        >
          Try again
        </button>
        <button
          type="button"
          onClick={() => discard.mutate()}
          disabled={busy}
          className="rounded-lg border border-line px-3 py-1.5 text-sm text-muted transition hover:bg-sunken disabled:opacity-50"
        >
          Discard
        </button>
      </div>
    </li>
  )
}

function Tile({ label, value, tone }: { label: string; value: number; tone?: 'bad' | 'warn' }) {
  const colour = tone === 'bad' ? 'text-red-500' : tone === 'warn' ? 'text-safelight' : 'text-ink'
  return (
    <div className="rounded-xl border border-line p-4">
      <p className="label-micro text-[10px] text-muted">{label}</p>
      <p className={`mt-1 font-mono text-2xl tabular-nums ${colour}`}>{value.toLocaleString()}</p>
    </div>
  )
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : 'That did not work'
}
