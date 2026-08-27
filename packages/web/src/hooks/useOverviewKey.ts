import { useEffect } from 'react'

/**
 * `z` for the overview — zoom out.
 *
 * Guarded rather than bound bare: the viewer owns the keyboard while it is open, and a
 * letter typed into a search field, an album name or a description is a letter, not a
 * shortcut.
 */
export function useOverviewKey(
  grid: { setShowingOverview: (open: boolean) => void; showingOverview: boolean },
  openId: string | null,
): void {
  const { setShowingOverview, showingOverview } = grid
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'z' || event.metaKey || event.ctrlKey || event.altKey) return
      if (openId) return
      const target = event.target
      if (target instanceof HTMLElement && target.closest('input, textarea, [contenteditable]')) {
        return
      }
      setShowingOverview(!showingOverview)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [openId, setShowingOverview, showingOverview])
}
