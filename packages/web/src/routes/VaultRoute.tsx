import type { Asset } from '@imogen/shared'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useMemo, useState } from 'react'
import { EmptyState } from '../components/EmptyState.tsx'
import { PhotoGrid } from '../components/PhotoGrid.tsx'
import { SelectionBar } from '../components/SelectionBar.tsx'
import { Viewer } from '../components/Viewer.tsx'
import { useGridLayout } from '../hooks/useGridLayout.ts'
import { useSelection } from '../hooks/useSelection.ts'
import { useAssetTable } from '../hooks/useTimeline.ts'
import { useViewerParam } from '../hooks/useViewerParam.ts'
import { imogen } from '../lib/client.ts'

/**
 * The vault. Photographs in here are absent from the timeline, from search, from albums,
 * from shared links, and from anything an AI assistant can reach — and getting in means
 * entering the vault passphrase again, even though you are already signed in.
 */
export function VaultRoute() {
  const queryClient = useQueryClient()
  const { openId, open: openPhoto, replace: showPhoto, close: closePhoto } = useViewerParam()

  const { data: status, isPending } = useQuery({
    queryKey: ['vault-status'],
    queryFn: () => imogen.vault.status(),
    // Never cached: the answer changes the moment the unlock expires.
    staleTime: 0,
  })

  const { data: assets } = useQuery({
    queryKey: ['vault-assets'],
    queryFn: () => imogen.vault.list(),
    enabled: status?.unlocked === true,
  })

  const ids = assets?.map((a) => a.id) ?? []
  const { selected, toggle, clear, selectAll } = useSelection(ids)

  const { containerRef, options } = useGridLayout()
  const photographs = useMemo(() => assets ?? [], [assets])
  const { table, tiles } = useAssetTable(photographs, options)

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ['vault-status'] })
    void queryClient.invalidateQueries({ queryKey: ['vault-assets'] })
    void queryClient.invalidateQueries({ queryKey: ['assets'] })
  }

  const moveOut = useMutation({
    mutationFn: (assetIds: string[]) => imogen.vault.moveOut(assetIds),
    onSuccess: () => {
      clear()
      refresh()
    },
  })

  const lock = useMutation({
    mutationFn: () => imogen.vault.lock(),
    onSuccess: refresh,
  })

  if (isPending) return <div className="h-40 animate-pulse rounded-lg bg-sunken" />

  if (!status?.configured) return <VaultSetup onDone={refresh} />
  if (!status.unlocked) return <VaultLocked onUnlocked={refresh} />

  const openIndex = openId && assets ? assets.findIndex((a) => a.id === openId) : -1

  return (
    <>
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2.5">
          <LockIcon open />
          <h1 className="heading-display text-2xl md:text-[28px]">Vault</h1>
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

      {assets && assets.length > 0 ? (
        <PhotoGrid
          table={table}
          tiles={tiles}
          options={options}
          containerRef={containerRef}
          selected={selected}
          onOpen={(tile) => openPhoto(tile.id)}
          onToggleSelect={(tile, shiftKey) => toggle(tile.id, shiftKey)}
        />
      ) : (
        <EmptyState
          headline="The vault is empty"
          body="Select photos in your library and choose Move to vault. They disappear from the timeline, from search, and from your assistants."
        />
      )}

      {selected.size > 0 && (
        <SelectionBar
          count={selected.size}
          onClear={clear}
          onSelectAll={selectAll}
          actions={[
            {
              label: 'Move out of vault',
              onClick: () => moveOut.mutate([...selected]),
              icon: 'M12 15V5m0 0 4 4m-4-4-4 4M5 19h14',
            },
          ]}
        />
      )}

      {openIndex >= 0 && assets?.[openIndex] && (
        <Viewer
          asset={assets[openIndex] as Asset}
          hasPrevious={openIndex > 0}
          hasNext={openIndex < assets.length - 1}
          onClose={() => closePhoto()}
          onPrevious={() => showPhoto(assets[openIndex - 1]?.id ?? '')}
          onNext={() => showPhoto(assets[openIndex + 1]?.id ?? '')}
          onToggleFavorite={() => {}}
          onTrash={(asset) => {
            closePhoto()
            void imogen.assets.trash([asset.id]).then(refresh)
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
