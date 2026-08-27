import { useMutation, useQuery } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { imogen } from '../lib/client.ts'
import { QrCode } from './QrCode.tsx'

/**
 * Setting up the phone applications.
 *
 * Every self-hosted photo app asks a new phone for a hostname first, and it is the worst
 * moment in the whole installation: a keyboard, an address somebody chose themselves, and
 * a sign-in screen that cannot even be drawn until the address is right.
 *
 * This browser already knows the address and is already signed in. So it says both at
 * once, in a square the camera reads in one go. What the square carries is a one-time
 * ticket, not a token — the app turns it into a grant of its own, with a PKCE verifier
 * this page never sees, which is why photographing the screen over somebody's shoulder
 * gets you nothing.
 */
export function PairDevice({ onClose }: { onClose: () => void }) {
  const [copied, setCopied] = useState(false)

  const ticket = useMutation({ mutationFn: () => imogen.pairing.create() })
  const create = ticket.mutate
  useEffect(() => {
    create()
  }, [create])

  const issued = ticket.data
  const expired = useExpiry(issued?.expiresAt)

  // Polled rather than pushed. A socket for a square somebody is pointing a phone at,
  // for at most five minutes, is a great deal of machinery for a spinner.
  const { data: status } = useQuery({
    queryKey: ['pairing', issued?.id],
    queryFn: () => imogen.pairing.status(issued?.id ?? ''),
    enabled: Boolean(issued) && !expired,
    refetchInterval: 2000,
  })

  const paired = Boolean(status?.claimedAt)

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div className="fixed inset-0 z-[60] grid place-items-center bg-black/40 p-4 backdrop-blur-sm">
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Pair a device"
        className="surface-panel w-full max-w-sm rounded-xl p-5"
      >
        <h2 className="heading-display mb-1 text-base">Pair a device</h2>
        <p className="mb-4 text-sm leading-relaxed text-muted">
          {paired
            ? 'Done. The app is signed in to this account.'
            : 'Open imogen on your phone or tablet, choose Scan, and point it at this.'}
        </p>

        <div className="grid place-items-center rounded-lg border border-line bg-white p-3">
          {paired ? (
            <Paired deviceName={status?.deviceName ?? null} />
          ) : expired || ticket.isError ? (
            <Lapsed
              message={ticket.isError ? 'That did not work. Try again.' : 'This code has expired.'}
              onRetry={() => create()}
            />
          ) : issued ? (
            <QrCode value={issued.uri} />
          ) : (
            <div className="h-[220px] w-[220px] animate-pulse rounded-lg bg-black/5" />
          )}
        </div>

        {issued && !paired && !expired && (
          <>
            {/* The same ticket, for a phone that is already reading this page. */}
            <a
              href={issued.uri}
              className="mt-3 block rounded-lg bg-ink px-3 py-2 text-center text-sm font-medium text-paper transition hover:opacity-90"
            >
              Open the imogen app on this device
            </a>
            <button
              type="button"
              onClick={() => {
                void navigator.clipboard.writeText(issued.uri)
                setCopied(true)
                window.setTimeout(() => setCopied(false), 1500)
              }}
              className="mt-2 w-full rounded-lg border border-line px-3 py-2 text-sm transition hover:bg-sunken"
            >
              {copied ? 'Copied' : 'Copy the pairing link'}
            </button>
            <p className="mt-3 text-xs leading-relaxed text-muted">
              The code works once, and only for the next few minutes. It signs the app in as you,
              without administration access.
            </p>
          </>
        )}

        <div className="mt-5 flex justify-end">
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg border border-line px-3 py-1.5 text-sm transition hover:bg-sunken"
          >
            {paired ? 'Done' : 'Close'}
          </button>
        </div>
      </div>
    </div>
  )
}

function Paired({ deviceName }: { deviceName: string | null }) {
  return (
    <div className="grid h-[220px] w-[220px] place-content-center gap-2 text-center">
      <div className="text-3xl text-ink">✓</div>
      <div className="text-sm text-ink">{deviceName ?? 'A device'} is connected</div>
    </div>
  )
}

function Lapsed({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="grid h-[220px] w-[220px] place-content-center gap-3 px-4 text-center">
      <p className="text-sm text-ink">{message}</p>
      <button
        type="button"
        onClick={onRetry}
        className="rounded-lg bg-ink px-3 py-1.5 text-sm text-paper transition hover:opacity-90"
      >
        New code
      </button>
    </div>
  )
}

/** True once the ticket has lapsed, so the square stops claiming to be usable. */
function useExpiry(expiresAt: string | undefined): boolean {
  const [expired, setExpired] = useState(false)

  useEffect(() => {
    setExpired(false)
    if (!expiresAt) return
    const remaining = new Date(expiresAt).getTime() - Date.now()
    if (remaining <= 0) {
      setExpired(true)
      return
    }
    const timer = window.setTimeout(() => setExpired(true), remaining)
    return () => window.clearTimeout(timer)
  }, [expiresAt])

  return expired
}
