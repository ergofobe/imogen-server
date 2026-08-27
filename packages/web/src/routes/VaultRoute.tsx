import type { AssetSelection } from '@imogen/shared'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { SelectionBar } from '../components/SelectionBar.tsx'
import { TimelineBody, TimelineCount } from '../components/TimelineBody.tsx'
import { TimelineSkeleton } from '../components/TimelineSkeleton.tsx'
import { Viewer } from '../components/Viewer.tsx'
import { useOverviewKey } from '../hooks/useOverviewKey.ts'
import { useSelection } from '../hooks/useSelection.ts'
import type { TimelineSource } from '../hooks/useTimeline.ts'
import { useTimelineGrid } from '../hooks/useTimelineGrid.ts'
import { useTimelineViewer } from '../hooks/useTimelineViewer.ts'
import { imogen } from '../lib/client.ts'

/**
 * The vault's own spine.
 *
 * `AssetFilter` deliberately cannot express "inside the vault" — that refusal is what the
 * vault IS — so the vault cannot be a filter on the library's timeline and has to be its
 * own source instead, scoped server-side behind the unlock. No `stats`, because the
 * library count the timeline watches excludes vaulted photographs on purpose: a tick here
 * would be asking a question about somewhere else.
 */
const VAULT_SOURCE: TimelineSource = {
  key: 'vault',
  timeline: (query) => imogen.vault.timeline({ covers: query.covers }),
  bucket: (query) =>
    imogen.vault.timelineBucket({
      period: query.period,
      ...(query.cursor ? { cursor: query.cursor } : {}),
    }),
}

/** Nothing about the vault is a filter, so its timeline is asked for with no filter at all. */
const NO_FILTER = {}

export function VaultRoute() {
  const queryClient = useQueryClient()

  const { data: status, isPending } = useQuery({
    queryKey: ['vault-status'],
    queryFn: () => imogen.vault.status(),
    // Never cached: the answer changes the moment the unlock expires.
    staleTime: 0,
  })

  const unlocked = status?.unlocked === true
  // Nothing is asked for until the vault is actually open: its endpoints refuse a
  // locked session, and a refusal is not a thing to go and collect on every mount.
  const grid = useTimelineGrid(NO_FILTER, { source: VAULT_SOURCE, enabled: unlocked })
  const viewer = useTimelineViewer({ ...grid, scope: 'vault' })
  useOverviewKey(grid, viewer.openId)

  /*
   * `query: null`, because the vault is deliberately absent from every filter there is.
   * So select-all here names its ids rather than a filter — which is honest, and is why
   * the ids come from the spine's own count of what is loaded rather than from a
   * server-side resolve that no filter could perform.
   */
  const selection = useSelection({
    query: null,
    orderedIds: grid.ids,
    // The spine's own count, not the loaded ids' — which is what lets `canSelectAll`
    // notice when the two differ and stop offering a select-all that would not be one.
    totalCount: grid.totalCount,
  })

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ['vault-status'] })
    void queryClient.invalidateQueries({ queryKey: ['asset'] })
    void queryClient.invalidateQueries({ queryKey: ['assets'] })
    void queryClient.invalidateQueries({ queryKey: ['timeline'] })
    grid.reload()
  }

  const moveOut = useMutation({
    mutationFn: (request: AssetSelection) => imogen.vault.moveOut(request),
    onSuccess: () => {
      selection.clear()
      refresh()
    },
  })

  const trash = useMutation({
    mutationFn: (request: AssetSelection) => imogen.assets.trash(request),
    onSuccess: () => {
      selection.clear()
      refresh()
    },
  })

  const lock = useMutation({
    mutationFn: () => imogen.vault.lock(),
    onSuccess: refresh,
  })

  if (isPending) return <TimelineSkeleton />

  if (!status?.configured) return <VaultSetup onDone={refresh} />
  if (!unlocked) return <VaultLocked onUnlocked={refresh} />

  return (
    <>
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3 pr-11">
        <div className="flex items-center gap-2.5">
          <LockIcon open />
          <h1 className="heading-display text-2xl md:text-[28px]">Vault</h1>
          {/*
            The count that was missing entirely. The vault page used to draw two hundred
            photographs with nothing anywhere on it saying how many there were, so a vault
            holding two thousand looked exactly like a vault holding two hundred — the
            worst of the four, because nothing contradicted it.
          */}
          <TimelineCount
            totalCount={grid.totalCount}
            onShowOverview={() => grid.setShowingOverview(true)}
          />
        </div>
        <div className="flex items-center gap-3">
          <span className="label-micro">Locks itself after 15 minutes</span>
          <button
            type="button"
            onClick={() => lock.mutate()}
            className="rounded-lg border border-line px-3 py-1.5 text-sm transition hover:bg-sunken"
          >
            Lock now
          </button>
        </div>
      </div>

      <TimelineBody
        grid={grid}
        filter={NO_FILTER}
        source={VAULT_SOURCE}
        empty={{
          headline: 'The vault is empty',
          body: 'Select photos in your library and choose Move to vault. They disappear from the timeline, from search, and from your assistants.',
        }}
        isSelected={selection.isSelected}
        selecting={selection.selecting}
        onOpen={(tile) => viewer.open(tile.id)}
        onToggleSelect={(tile, shiftKey) => selection.toggle(tile.id, shiftKey)}
      />

      {selection.selecting && (
        <SelectionBar
          count={selection.count}
          onClear={selection.clear}
          onSelectAll={selection.selectAll}
          canSelectAll={selection.canSelectAll}
          refusal={selection.refusal}
          actions={[
            {
              label: 'Move out of vault',
              onClick: () => moveOut.mutate(selection.toRequest()),
              icon: 'M12 15V5m0 0 4 4m-4-4-4 4M5 19h14',
            },
          ]}
        />
      )}

      {viewer.asset && (
        <Viewer
          asset={viewer.asset}
          hasPrevious={viewer.hasPrevious}
          hasNext={viewer.hasNext}
          onClose={viewer.close}
          onPrevious={() => viewer.step(-1)}
          onNext={() => viewer.step(1)}
          onToggleFavorite={() => {}}
          onTrash={(asset) => {
            viewer.close()
            trash.mutate({ assetIds: [asset.id] })
          }}
        />
      )}
    </>
  )
}

function VaultSetup({ onDone }: { onDone: () => void }) {
  const [passphrase, setPassphrase] = useState('')
  const [confirm, setConfirm] = useState('')
  const [error, setError] = useState<string | null>(null)

  async function submit(event: React.FormEvent) {
    event.preventDefault()
    setError(null)
    if (passphrase !== confirm) return setError('Those passphrases do not match')
    try {
      await imogen.vault.setPassphrase(passphrase)
      await imogen.vault.unlock(passphrase)
      onDone()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not set up the vault')
    }
  }

  return (
    <Centered title="Set up your vault">
      <p className="mb-6 text-sm leading-relaxed text-muted">
        Photos you move here leave the timeline, search, your albums, and anything your AI
        assistants can see. Getting back in needs this passphrase, so choose one you will remember —
        nobody can reset it for you.
      </p>
      <form onSubmit={submit} className="space-y-3.5">
        <Field
          label="Vault passphrase"
          value={passphrase}
          onChange={setPassphrase}
          hint="At least 8 characters. Not your account password."
        />
        <Field label="Confirm passphrase" value={confirm} onChange={setConfirm} />
        {error && <p className="text-sm text-safelight">{error}</p>}
        <button
          type="submit"
          className="w-full rounded-lg bg-ink py-2.5 text-sm font-medium text-paper transition hover:opacity-90"
        >
          Create vault
        </button>
      </form>
    </Centered>
  )
}

function VaultLocked({ onUnlocked }: { onUnlocked: () => void }) {
  const [passphrase, setPassphrase] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function submit(event: React.FormEvent) {
    event.preventDefault()
    setError(null)
    setBusy(true)
    try {
      await imogen.vault.unlock(passphrase)
      onUnlocked()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'That passphrase is not correct')
      setPassphrase('')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Centered title="Vault locked">
      <p className="mb-6 text-sm leading-relaxed text-muted">
        Enter your vault passphrase to see what is inside. Being signed in is not enough.
      </p>
      <form onSubmit={submit} className="space-y-3.5">
        <Field
          label="Vault passphrase"
          value={passphrase}
          onChange={setPassphrase}
          autoFocusField
        />
        {error && <p className="text-sm text-safelight">{error}</p>}
        <button
          type="submit"
          disabled={busy}
          className="w-full rounded-lg bg-ink py-2.5 text-sm font-medium text-paper transition hover:opacity-90 disabled:opacity-50"
        >
          {busy ? 'Checking' : 'Unlock'}
        </button>
      </form>
    </Centered>
  )
}

function Centered({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mx-auto max-w-sm py-12">
      <div className="mb-5 flex items-center gap-2.5">
        <LockIcon />
        <h1 className="heading-display text-xl">{title}</h1>
      </div>
      {children}
    </div>
  )
}

function Field({
  label,
  value,
  onChange,
  hint,
  autoFocusField,
}: {
  label: string
  value: string
  onChange: (value: string) => void
  hint?: string
  autoFocusField?: boolean
}) {
  return (
    <label className="block">
      <span className="label-micro mb-1.5 block">{label}</span>
      <input
        type="password"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        autoComplete="off"
        required
        ref={autoFocusField ? (node) => node?.focus() : undefined}
        className="w-full rounded-lg border border-line bg-surface px-3 py-2.5 text-sm outline-none transition focus:border-safelight"
      />
      {hint && <span className="mt-1.5 block text-xs text-muted">{hint}</span>}
    </label>
  )
}

function LockIcon({ open = false }: { open?: boolean }) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="h-5 w-5 text-safelight"
    >
      <rect x="4" y="11" width="16" height="9" rx="2" />
      <path d={open ? 'M8 11V7a4 4 0 0 1 7.5-2' : 'M8 11V7a4 4 0 0 1 8 0v4'} />
    </svg>
  )
}
