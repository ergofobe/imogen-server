import qrcode from 'qrcode-generator'
import { useMemo } from 'react'

/**
 * A QR code, as one SVG path.
 *
 * Drawn as a single path rather than a rectangle per module because a code this size is
 * a few hundred of them, and a few hundred DOM nodes to display one square of black and
 * white is not a trade worth making.
 *
 * Error correction is M. A pairing code is read once, from a screen, from a foot away;
 * the higher levels buy resilience this will never need and spend it on density, which
 * is the thing that actually stops a camera reading it.
 */
export function QrCode({ value, size = 220 }: { value: string; size?: number }) {
  const { path, count } = useMemo(() => {
    // 0 picks the smallest version the data fits in.
    const qr = qrcode(0, 'M')
    qr.addData(value)
    qr.make()

    const count = qr.getModuleCount()
    const parts: string[] = []
    for (let row = 0; row < count; row += 1) {
      for (let column = 0; column < count; column += 1) {
        if (qr.isDark(row, column)) parts.push(`M${column},${row}h1v1h-1z`)
      }
    }
    return { path: parts.join(''), count }
  }, [value])

  // The quiet zone is part of the spec, not decoration: without it a reader cannot find
  // the edge of the code against whatever is behind it.
  const quiet = 4
  const extent = count + quiet * 2

  return (
    <svg
      viewBox={`0 0 ${extent} ${extent}`}
      width={size}
      height={size}
      role="img"
      aria-label="Pairing code"
      shapeRendering="crispEdges"
      className="rounded-lg"
    >
      <rect width={extent} height={extent} fill="#ffffff" />
      <g transform={`translate(${quiet} ${quiet})`}>
        <path d={path} fill="#000000" />
      </g>
    </svg>
  )
}
