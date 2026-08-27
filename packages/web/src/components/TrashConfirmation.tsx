import type { AssetSelection } from '@imogen/shared'
import { useCallback, useState } from 'react'
import { ConfirmDialog } from './ConfirmDialog.tsx'

type Asked = { request: AssetSelection; count: number }

/**
 * The request and its count, taken when the dialog opens rather than read when it is
 * confirmed.
 *
 * What the reader agreed to is the number they were shown. A selection that changed behind
 * an open dialog — a poll landing, a month arriving — would otherwise make those two
 * different things, and the whole point of the dialog is that they are the same thing.
 */
export function useTrashConfirmation() {
  const [asked, setAsked] = useState<Asked | null>(null)
  const ask = useCallback(
    (selection: { toRequest: () => AssetSelection; count: number }) =>
      setAsked({ request: selection.toRequest(), count: selection.count }),
    [],
  )
  const cancel = useCallback(() => setAsked(null), [])
  return { asked, ask, cancel }
}

export function TrashConfirmation({
  confirmation,
  onConfirm,
}: {
  confirmation: ReturnType<typeof useTrashConfirmation>
  onConfirm: (request: AssetSelection) => void
}) {
  const { asked, cancel } = confirmation
  if (!asked) return null

  return (
    <ConfirmDialog
      /*
       * The resolved figure, always. Under select-all this is the one place the reader
       * finds out whether "everything" is the twelve photographs on screen or thirty
       * thousand across twenty years, and a dialog that says "all photos" is asking them
       * to agree to a number it declined to tell them.
       */
      title={
        asked.count === 1
          ? 'Move this photo to the trash?'
          : `Move ${asked.count.toLocaleString()} photos to the trash?`
      }
      body={
        asked.count === 1
          ? 'It leaves the timeline and every album. You can put it back from the trash until it is swept.'
          : 'They leave the timeline and every album. You can put them back from the trash until it is swept.'
      }
      confirmLabel="Move to trash"
      destructive
      onConfirm={() => {
        const { request } = asked
        cancel()
        onConfirm(request)
      }}
      onCancel={cancel}
    />
  )
}
