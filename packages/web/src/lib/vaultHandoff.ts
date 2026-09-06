import type { AssetSelection } from '@imogen/shared'

/**
 * An action that turned out to need the vault open, carried to the unlock screen so the
 * unlock can finish it.
 *
 * It travels as history state rather than in the URL: a vault action names the very
 * photographs somebody is hiding, and the one place they must not appear is an address bar
 * — or a browser history entry anyone can read off the screen.
 *
 * History state survives a reload and comes back from whatever the previous page put
 * there, so it is checked rather than trusted.
 */
export type VaultHandoff = { moveIn: AssetSelection }

export function vaultHandoff(state: unknown): VaultHandoff | null {
  if (!state || typeof state !== 'object') return null
  const { moveIn } = state as { moveIn?: unknown }
  if (!moveIn || typeof moveIn !== 'object') return null
  return { moveIn: moveIn as AssetSelection }
}
