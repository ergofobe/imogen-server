import type { AssetFilter, AssetSelection } from '@imogen/shared'
import { useCallback, useMemo, useRef, useState } from 'react'

/**
 * What a bulk action acts on, said in whichever of the two ways is shorter.
 *
 * Naming the photographs works while there are a few dozen of them. It stops working the
 * moment "select all" means the filter rather than the screen: the timeline is windowed, so
 * the ids in hand are the eight months that happen to be loaded, and sending those would
 * trash a slice of the library while the bar said it was trashing all of it. Under `all` the
 * request carries the filter the reader was looking at and the handful they unticked, which
 * is one small request whether it matches twelve photographs or ninety thousand.
 *
 * The two halves are kept as pure functions with the hook built on them, because everything
 * that can go wrong here is a wrong ANSWER rather than a wrong render — the wrong request
 * body, the wrong count in a confirmation — and those are worth being able to ask about
 * directly.
 */
export type Selection = { kind: 'ids'; ids: Set<string> } | { kind: 'all'; except: Set<string> }

export const NOTHING_SELECTED: Selection = { kind: 'ids', ids: new Set() }

/**
 * The server's own ceilings, restated here so the interface can stop short of them rather
 * than discover them. It rejects past either rather than truncating, which is the right
 * choice — a bulk trash that quietly spared four hundred photographs is a bug nobody finds
 * until they go looking for them — and it leaves the client with a decision to make.
 */
export const EXPLICIT_ID_LIMIT = 1000
export const EXCEPTION_LIMIT = 10_000

/** The `AssetSelection` the server takes, from whichever way the reader said it. */
export function toRequest(selection: Selection, query: Partial<AssetFilter>): AssetSelection {
  // Exactly one of `assetIds` and `query`: the schema refuses a body carrying both.
  if (selection.kind === 'ids') return { assetIds: [...selection.ids] }
  // `except: []` rather than an absent one, so the body is the same shape whether or not
  // anything was unticked and a reader of the access log can tell the two apart.
  return { query, except: [...selection.except] }
}

/** A click on one photograph, which means the opposite thing under each kind. */
export function toggleIn(selection: Selection, id: string): Selection {
  if (selection.kind === 'ids') {
    const ids = new Set(selection.ids)
    if (!ids.delete(id)) ids.add(id)
    return { kind: 'ids', ids }
  }
  const except = new Set(selection.except)
  if (!except.delete(id)) except.add(id)
  return { kind: 'all', except }
}

/**
 * A shift-click's run, taken the same direction as the plain click it extends: ticking under
 * an id selection, unticking under select-all. A modifier that reversed the action it
 * modifies would be a strange thing to hand somebody.
 */
export function extendIn(selection: Selection, ids: string[]): Selection {
  if (selection.kind === 'ids') {
    const next = new Set(selection.ids)
    for (const id of ids) next.add(id)
    return { kind: 'ids', ids: next }
  }
  const except = new Set(selection.except)
  for (const id of ids) except.add(id)
  return { kind: 'all', except }
}

export function isSelectedIn(selection: Selection, id: string): boolean {
  return selection.kind === 'ids' ? selection.ids.has(id) : !selection.except.has(id)
}

/**
 * How many photographs this will actually touch.
 *
 * This is the number a destructive confirmation has to say. "Move all photos to the trash?"
 * is the single worst thing this feature could put in front of somebody: it is the one
 * question where what they need to know — how much — is the one word the dialog left out.
 * Under select-all it is the spine's total less what was unticked, and the spine counts
 * every day the filter matches rather than the days that happen to be loaded.
 */
export function resolvedCount(selection: Selection, totalCount: number): number {
  if (selection.kind === 'ids') return selection.ids.size
  // Floored at zero: the exclusions are client state and the total comes from the spine, so
  // a mutation landing between the two can make the subtraction go negative, and a dialog
  // offering to trash minus three photographs is worse than one offering to trash none.
  return Math.max(0, totalCount - selection.except.size)
}

/**
 * Why the server would refuse this selection, or null.
 *
 * Refused in the interface rather than sent and caught, and refused rather than trimmed to
 * fit. Trimming is the tempting one and it is wrong: the reader asked for a set, and quietly
 * acting on a different set is exactly the failure a confirmation dialog exists to prevent.
 */
export function selectionRefusal(selection: Selection): string | null {
  if (selection.kind === 'ids' && selection.ids.size > EXPLICIT_ID_LIMIT) {
    return `Selections are limited to ${EXPLICIT_ID_LIMIT.toLocaleString()} photos at a time. Select all acts on everything this view matches, however many that is.`
  }
  if (selection.kind === 'all' && selection.except.size > EXCEPTION_LIMIT) {
    return `More than ${EXCEPTION_LIMIT.toLocaleString()} photos have been unticked, which is more than one request can carry. Narrow the view, or clear this and pick the ones you want.`
  }
  return null
}

export type SelectionState = {
  selection: Selection
  /** Resolved against the spine's total, so select-all is a number rather than a word. */
  count: number
  /** Whether anything is selected at all, which is what puts the grid into selecting mode. */
  selecting: boolean
  isSelected: (id: string) => boolean
  toggle: (id: string, shiftKey?: boolean) => void
  selectAll: () => void
  clear: () => void
  toRequest: () => AssetSelection
  /** Set when the server would refuse this selection; the bar says it and stops the click. */
  refusal: string | null
}

/**
 * Multi-select with a shift-click range, because choosing eighty holiday photos one click at
 * a time is not a thing anyone should have to do — and a select-all that is the filter
 * rather than a list, because in a windowed timeline a list is only ever the loaded part.
 *
 * `query` is what this view is a view OF. A view that cannot be written as a filter — the
 * vault, which is deliberately absent from every filter there is — passes null and gets a
 * select-all that names its ids, which is honest for a page that holds at most a couple of
 * hundred of them and never windows.
 */
export function useSelection(options: {
  query: Partial<AssetFilter> | null
  orderedIds: string[]
  /** From the spine, not from `orderedIds`: the loaded months are not the library. */
  totalCount: number
}): SelectionState {
  const { query, orderedIds, totalCount } = options
  const [selection, setSelection] = useState<Selection>(NOTHING_SELECTED)
  const anchor = useRef<string | null>(null)

  const toggle = useCallback(
    (id: string, shiftKey = false) => {
      setSelection((current) => {
        if (shiftKey && anchor.current) {
          const from = orderedIds.indexOf(anchor.current)
          const to = orderedIds.indexOf(id)
          if (from >= 0 && to >= 0) {
            const [start, end] = from < to ? [from, to] : [to, from]
            return extendIn(current, orderedIds.slice(start, end + 1))
          }
        }
        anchor.current = id
        return toggleIn(current, id)
      })
    },
    [orderedIds],
  )

  const clear = useCallback(() => {
    setSelection(NOTHING_SELECTED)
    anchor.current = null
  }, [])

  const selectAll = useCallback(() => {
    anchor.current = null
    // With a filter to name, select-all is that filter and costs one request. Without one it
    // can only be the ids in hand — which for the vault is all of them, and for anything
    // windowed would not be, so nothing windowed passes null.
    setSelection(
      query ? { kind: 'all', except: new Set() } : { kind: 'ids', ids: new Set(orderedIds) },
    )
  }, [query, orderedIds])

  const isSelected = useCallback((id: string) => isSelectedIn(selection, id), [selection])

  const request = useCallback(() => toRequest(selection, query ?? {}), [selection, query])

  const count = useMemo(() => resolvedCount(selection, totalCount), [selection, totalCount])

  return {
    selection,
    count,
    // Under select-all with everything unticked there is nothing selected and no bar, even
    // though the kind still says `all`. The count is the truth; the kind is the bookkeeping.
    selecting: count > 0,
    isSelected,
    toggle,
    selectAll,
    clear,
    toRequest: request,
    refusal: useMemo(() => selectionRefusal(selection), [selection]),
  }
}
