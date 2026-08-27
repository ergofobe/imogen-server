/** Mirrors the real grid's rhythm, so nothing jumps when the photos arrive. */
export function TimelineSkeleton({ title }: { title?: string }) {
  return (
    <>
      {title && <h1 className="heading-display mb-5 text-2xl md:text-[28px]">{title}</h1>}
      {/* biome-ignore-start lint/suspicious/noArrayIndexKey: a fixed skeleton never reorders */}
      <div className="space-y-1">
        {[3, 4, 3, 5].map((count, row) => (
          <div key={`row-${row}-${count}`} className="flex gap-1" style={{ height: 200 }}>
            {Array.from({ length: count }, (_, i) => (
              <div
                key={`cell-${row}-${i}`}
                className="animate-pulse rounded-[--radius-tile] bg-sunken"
                style={{ flex: `${1 + ((i * 7) % 5) / 10} 1 0` }}
              />
            ))}
          </div>
        ))}
      </div>
      {/* biome-ignore-end lint/suspicious/noArrayIndexKey: a fixed skeleton never reorders */}
    </>
  )
}
