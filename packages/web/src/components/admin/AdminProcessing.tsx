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
    </div>
  )
}

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
