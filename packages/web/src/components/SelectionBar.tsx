type Action = { label: string; onClick: () => void; icon: string }

/**
 * Appears only while something is selected, and says exactly what will happen. Every
 * action keeps the same name it will use in its confirmation.
 *
 * The count is the resolved one — the filter's total less what was unticked, not the number
 * of tiles that happen to be loaded — and it is grouped, because select-all is the one
 * selection whose size the reader has no other way of seeing and 12431 is not a number
 * anybody reads at a glance.
 */
export function SelectionBar({
  count,
  onClear,
  onSelectAll,
  actions,
  refusal = null,
}: {
  count: number
  onClear: () => void
  onSelectAll: () => void
  actions: Action[]
  /** Why the server would refuse this selection. Said plainly, and the actions go dead. */
  refusal?: string | null
}) {
  return (
    <div className="fixed inset-x-0 bottom-0 z-40 flex flex-col items-center gap-2 p-4 pb-[max(1rem,calc(env(safe-area-inset-bottom)+4.5rem))] md:pb-6">
      {refusal && (
        <p
          role="status"
          className="surface-panel max-w-md rounded-xl px-3.5 py-2 text-sm text-muted"
        >
          {refusal}
        </p>
      )}

      <div className="surface-panel flex items-center gap-1 rounded-full px-2 py-1.5">
        <span className="px-3 font-mono text-[13px] tabular-nums">
          {count.toLocaleString()} selected
        </span>

        <span aria-hidden="true" className="mx-1 h-5 w-px bg-line" />

        <button
          type="button"
          onClick={onSelectAll}
          className="rounded-full px-3 py-1.5 text-sm text-muted transition hover:bg-sunken hover:text-ink"
        >
          Select all
        </button>

        {actions.map((action) => (
          <button
            key={action.label}
            type="button"
            onClick={action.onClick}
            // Refused selections take the buttons with them. Clearing stays live below,
            // because it is the way out of the state the refusal is describing.
            disabled={refusal !== null}
            className="flex items-center gap-1.5 rounded-full px-3 py-1.5 text-sm transition hover:bg-sunken disabled:opacity-40 disabled:hover:bg-transparent"
          >
            <svg
              aria-hidden="true"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.6"
              strokeLinecap="round"
              strokeLinejoin="round"
              className="h-4 w-4"
            >
              <path d={action.icon} />
            </svg>
            {action.label}
          </button>
        ))}

        <button
          type="button"
          onClick={onClear}
          aria-label="Clear selection"
          className="grid h-8 w-8 place-items-center rounded-full text-muted transition hover:bg-sunken hover:text-ink"
        >
          <svg
            aria-hidden="true"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.7"
            strokeLinecap="round"
            className="h-4 w-4"
          >
            <path d="M6 6l12 12M18 6L6 18" />
          </svg>
        </button>
      </div>
    </div>
  )
}
