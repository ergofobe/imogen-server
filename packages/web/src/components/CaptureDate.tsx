import type { Asset } from '@imogen/shared'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { imogen } from '../lib/client.ts'
import { formatExact } from '../lib/format.ts'

/**
 * Query keys whose data holds assets, and so goes stale when a date changes.
 *
 * `timeline` is the spine the windowed grid is laid out from, and `asset` is the whole
 * photograph the viewer fetches for itself. The grid's tile map follows the spine on its
 * own — it refetches whatever month the new counts disagree with — so refreshing the spine
 * is all this has to do.
 */
const ASSET_QUERIES = new Set(['assets', 'album', 'person', 'vault-assets', 'timeline', 'asset'])

const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
]

const WEEKDAYS = ['S', 'M', 'T', 'W', 'T', 'F', 'S']

/** Photography is younger than this, and a capture date below it is a typo. */
const EARLIEST_YEAR = 1826

/**
 * When the photograph was taken, and a way to say so when the file got it wrong.
 *
 * Scans and files stripped of their metadata arrive dated the day they were uploaded,
 * which drops them at the wrong end of the timeline. Correcting the date here changes
 * only this library's record of it: the uploaded file is never rewritten, so the
 * camera's own EXIF survives, and the date the photo arrived with can be put back.
 */
export function CaptureDate({ asset, editable }: { asset: Asset; editable: boolean }) {
  const queryClient = useQueryClient()
  const [draft, setDraft] = useState<Date | null>(null)

  const refresh = () =>
    queryClient.invalidateQueries({
      predicate: (query) => ASSET_QUERIES.has(query.queryKey[0] as string),
    })

  const close = () => setDraft(null)

  const save = useMutation({
    mutationFn: (at: Date) => imogen.assets.update(asset.id, { capturedAt: at.toISOString() }),
    onSuccess: () => {
      close()
      void refresh()
    },
  })

  const revert = useMutation({
    mutationFn: () => imogen.assets.update(asset.id, { resetCapturedAt: true }),
    onSuccess: () => {
      close()
      void refresh()
    },
  })

  const corrected = asset.capturedAtOriginal !== null

  if (draft) {
    return (
      // Full width rather than the narrow value column: a calendar does not fit in it.
      <div className="rounded-lg border border-white/15 bg-white/5 p-3">
        <h3 className="label-micro mb-3 text-white/45">Taken</h3>
        <Calendar value={draft} onChange={setDraft} />

        <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-white/10 pt-3">
          <button
            type="button"
            onClick={() => save.mutate(draft)}
            disabled={save.isPending}
            className="rounded-md bg-white/90 px-3 py-1.5 text-xs font-medium text-black transition hover:bg-white disabled:opacity-50"
          >
            {save.isPending ? 'Setting' : 'Set date'}
          </button>
          <button
            type="button"
            onClick={close}
            className="rounded-md px-2 py-1.5 text-xs text-white/60 transition hover:text-white"
          >
            Cancel
          </button>
          {corrected && (
            <button
              type="button"
              onClick={() => revert.mutate()}
              disabled={revert.isPending}
              className="ml-auto text-xs text-white/50 underline decoration-white/25 underline-offset-4 transition hover:text-white disabled:opacity-50"
            >
              Use the file’s date
            </button>
          )}
          {(save.isError || revert.isError) && (
            <span className="text-xs text-red-300">Could not save</span>
          )}
        </div>
      </div>
    )
  }

  return (
    <div className="grid grid-cols-[7.5rem_1fr] gap-3">
      <dt className="label-micro pt-0.5 text-white/45">Taken</dt>
      <dd className="font-mono text-[13px] leading-relaxed break-words text-white/90">
        {editable ? (
          <button
            type="button"
            onClick={() => setDraft(new Date(asset.capturedAt))}
            title="Correct this date"
            className="text-left underline decoration-white/20 underline-offset-4 transition hover:decoration-white/60"
          >
            {formatExact(asset.capturedAt)}
          </button>
        ) : (
          formatExact(asset.capturedAt)
        )}

        {corrected && (
          <p className="mt-1 text-xs leading-relaxed text-white/45">
            Edited — the file said {formatExact(asset.capturedAtOriginal!)}
          </p>
        )}
        {!corrected && !asset.capturedAtIsExact && (
          <p className="mt-1 text-xs leading-relaxed text-white/45">
            Estimated — this file carried no capture time
          </p>
        )}
      </dd>
    </div>
  )
}

/**
 * A month at a time, with the year and month picked directly.
 *
 * Stepping a calendar back one month at a time is fine for last week's photos and
 * hopeless for a scan from 1974, which is exactly the picture whose date needs fixing.
 * So the year and month are fields in their own right, and the grid follows them.
 */
function Calendar({ value, onChange }: { value: Date; onChange: (next: Date) => void }) {
  const year = value.getFullYear()
  const month = value.getMonth()
  const day = value.getDate()

  const daysInMonth = new Date(year, month + 1, 0).getDate()
  const blanks = new Date(year, month, 1).getDay()

  /** Keeps the day in range when a shorter month is chosen — 31 January to February. */
  const withParts = (nextYear: number, nextMonth: number, nextDay: number) => {
    const last = new Date(nextYear, nextMonth + 1, 0).getDate()
    return new Date(
      nextYear,
      nextMonth,
      Math.min(nextDay, last),
      value.getHours(),
      value.getMinutes(),
    )
  }

  const step = (months: number) => {
    const target = new Date(year, month + months, 1)
    onChange(withParts(target.getFullYear(), target.getMonth(), day))
  }

  return (
    <>
      <div className="flex items-center gap-1.5">
        <Stepper label="Previous month" onClick={() => step(-1)} d="M15 6l-6 6 6 6" />

        <select
          aria-label="Month"
          value={month}
          onChange={(event) => onChange(withParts(year, Number(event.target.value), day))}
          className="min-w-0 flex-1 rounded-md border border-white/15 bg-black/40 px-2 py-1 text-xs text-white outline-none focus:border-safelight"
        >
          {MONTHS.map((name, index) => (
            <option key={name} value={index}>
              {name}
            </option>
          ))}
        </select>

        <YearField year={year} onPick={(next) => onChange(withParts(next, month, day))} />

        <Stepper label="Next month" onClick={() => step(1)} d="M9 6l6 6-6 6" />
      </div>

      <div className="mt-2.5 grid grid-cols-7 gap-0.5 text-center">
        {WEEKDAYS.map((letter, index) => (
          <span
            // biome-ignore lint/suspicious/noArrayIndexKey: two days share an initial
            key={`${letter}-${index}`}
            className="label-micro py-1 text-[10px] text-white/35"
          >
            {letter}
          </span>
        ))}

        {Array.from({ length: blanks }, (_, index) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: empty spacers, holding no state
          <span key={`blank-${index}`} />
        ))}

        {Array.from({ length: daysInMonth }, (_, index) => index + 1).map((number) => (
          <button
            key={number}
            type="button"
            onClick={() => onChange(withParts(year, month, number))}
            className={`rounded-md py-1 font-mono text-xs transition ${
              number === day
                ? 'bg-safelight font-medium text-white'
                : 'text-white/70 hover:bg-white/10 hover:text-white'
            }`}
          >
            {number}
          </button>
        ))}
      </div>

      <label className="mt-3 flex items-center gap-2 border-t border-white/10 pt-3">
        <span className="label-micro text-white/45">Time</span>
        <input
          type="time"
          value={`${String(value.getHours()).padStart(2, '0')}:${String(value.getMinutes()).padStart(2, '0')}`}
          onChange={(event) => {
            const [hours, minutes] = event.target.value.split(':').map(Number)
            if (hours === undefined || minutes === undefined || Number.isNaN(hours)) return
            onChange(new Date(year, month, day, hours, minutes))
          }}
          className="rounded-md border border-white/15 bg-black/40 px-2 py-1 font-mono text-xs text-white outline-none focus:border-safelight [color-scheme:dark]"
        />
      </label>
    </>
  )
}

/**
 * The year as a field you can actually type in.
 *
 * Held as text while it is being edited, because a year is entered a digit at a time:
 * validating each keystroke against the earliest possible year would reject "1" on the
 * way to 1974 and snap the field back, leaving the steppers as the only way through a
 * span of decades.
 */
function YearField({ year, onPick }: { year: number; onPick: (year: number) => void }) {
  const [text, setText] = useState(String(year))

  // Follow the calendar when the year moves for another reason — stepping past December.
  useEffect(() => setText(String(year)), [year])

  return (
    <input
      aria-label="Year"
      type="number"
      inputMode="numeric"
      min={EARLIEST_YEAR}
      max={9999}
      value={text}
      onChange={(event) => {
        setText(event.target.value)
        const next = Number(event.target.value)
        if (next >= EARLIEST_YEAR && next <= 9999) onPick(next)
      }}
      // Half-typed years are abandoned rather than guessed at.
      onBlur={() => setText(String(year))}
      className="w-16 rounded-md border border-white/15 bg-black/40 px-2 py-1 text-center font-mono text-xs text-white outline-none focus:border-safelight"
    />
  )
}

function Stepper({ label, onClick, d }: { label: string; onClick: () => void; d: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      className="grid h-7 w-7 shrink-0 place-items-center rounded-md text-white/60 transition hover:bg-white/10 hover:text-white"
    >
      <svg
        aria-hidden="true"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        className="h-3.5 w-3.5"
      >
        <path d={d} />
      </svg>
    </button>
  )
}
