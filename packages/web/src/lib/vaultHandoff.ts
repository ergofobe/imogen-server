import type { AssetSelection } from '@imogen/shared'
import { type PackedSelection, type Selection, unpackSelection } from '../hooks/useSelection.ts'

/**
 * An action that turned out to need the vault open, carried to the unlock screen so the
 * unlock can finish it — and, on the entry it came from, the selection to give back if the
 * reader decides against unlocking after all. Both halves name the same `errand`.
 *
 * They travel as history state rather than in the URL: a vault action names the very
 * photographs somebody is hiding, and the one place those must not appear is an address bar
 * — or a browser history entry anyone can read off the screen.
 *
 * History state survives a reload and comes back from whatever the previous page put there,
 * so both halves are checked rather than trusted.
 */
export type VaultHandoff = { moveIn: AssetSelection; errand: string }

/** What the library was holding when it sent the reader away, waiting on its own entry. */
export type VaultStash = { reselect: PackedSelection; errand: string }

export function vaultHandoff(state: unknown): VaultHandoff | null {
  const errand = errandIn(state)
  if (!errand) return null
  const { moveIn } = state as { moveIn?: unknown }
  if (!moveIn || typeof moveIn !== 'object') return null
  return { moveIn: moveIn as AssetSelection, errand }
}

export function vaultStash(state: unknown): { reselect: Selection; errand: string } | null {
  const errand = errandIn(state)
  if (!errand) return null
  const reselect = unpackSelection((state as { reselect?: unknown }).reselect)
  return reselect ? { reselect, errand } : null
}

function errandIn(state: unknown): string | null {
  if (!state || typeof state !== 'object') return null
  const { errand } = state as { errand?: unknown }
  return typeof errand === 'string' && errand.length > 0 ? errand : null
}

/**
 * Errands that have already been carried out.
 *
 * The stash outlives the errand: the history entry is still there after the move has gone
 * through, so a back gesture would re-select photographs that are now in the vault. That is
 * not merely untidy — an explicit id list is the one selection the server lets reach the
 * vault, deliberately, so the vault's own viewer can trash the photograph it is looking at.
 * A stale stash would therefore put vaulted photographs under the library's "Move to trash"
 * and that button would work.
 *
 * So a finished errand is written down somewhere with the same lifetime as the history entry
 * it invalidates: the tab. Only the errand's own id is stored, never a photograph's, and a
 * browser that refuses storage costs a stale selection rather than an exception.
 */
const SPENT = 'imogen:vault-errands-spent'

/** Older ones than this are behind history entries nobody is going back through. */
const REMEMBERED = 20

export function spendErrand(errand: string): void {
  try {
    sessionStorage.setItem(SPENT, JSON.stringify([...spentErrands(), errand].slice(-REMEMBERED)))
  } catch {
    // Storage refused, so the stash stays live. `restore` is the only thing that suffers.
  }
}

export function errandSpent(errand: string): boolean {
  return spentErrands().includes(errand)
}

function spentErrands(): string[] {
  try {
    const stored: unknown = JSON.parse(sessionStorage.getItem(SPENT) ?? '[]')
    return Array.isArray(stored) ? stored.filter((entry) => typeof entry === 'string') : []
  } catch {
    return []
  }
}
