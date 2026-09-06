import { useEffect, useRef } from 'react'

/** Says what happened and then gets out of the way. */
export function Notice({ notice, onDone }: { notice: string | null; onDone: () => void }) {
  const done = useRef(onDone)
  done.current = onDone
  useEffect(() => {
    if (!notice) return
    const timer = setTimeout(() => done.current(), 4000)
    return () => clearTimeout(timer)
  }, [notice])

  if (!notice) return null
  return (
    <div className="fixed inset-x-0 bottom-0 z-50 flex justify-center p-4 pb-[max(1rem,calc(env(safe-area-inset-bottom)+4.5rem))] md:pb-6">
      <p className="surface-panel rounded-full px-4 py-2 text-sm">{notice}</p>
    </div>
  )
}
