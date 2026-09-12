import { extname } from 'node:path'
import type { AssetType, ExifData, GeoPoint } from '@imogen/shared'
import exifr from 'exifr'
import type { Sharp } from 'sharp'
import sharp from 'sharp'
import { isPlaceableLatitude, isPlaceableLongitude, isUsableAltitude } from './coordinates.ts'
import { decodeImage, decodeWithFfmpeg } from './decode.ts'

const THUMBNAIL_EDGE = 320
const PREVIEW_EDGE = 1440

/** Formats sharp cannot open, which ffmpeg decodes for us instead. */
const IMAGE_EXTENSIONS = new Set([
  '.jpg',
  '.jpeg',
  '.png',
  '.gif',
  '.webp',
  '.avif',
  '.tif',
  '.tiff',
  '.bmp',
  '.heic',
  '.heif',
  '.jxl',
  // Camera RAW. sharp rejects these; the ffmpeg fallback handles them.
  '.cr2',
  '.cr3',
  '.nef',
  '.arw',
  '.dng',
  '.orf',
  '.raf',
  '.rw2',
  '.pef',
  '.srw',
])

const VIDEO_EXTENSIONS = new Set([
  '.mp4',
  '.mov',
  '.m4v',
  '.avi',
  '.mkv',
  '.webm',
  '.mpg',
  '.mpeg',
  '.3gp',
  '.wmv',
  '.flv',
])

export type ProcessResult = {
  type: AssetType
  width: number | null
  height: number | null
  duration: number | null
  /** Null when the file carried no capture time. Callers apply their own fallback. */
  capturedAt: Date | null
  /**
   * Whether `capturedAt` is anchored to a real UTC offset rather than read as UTC because
   * the file did not say. A caller holding a timestamp the device already resolved should
   * keep it over an unanchored reading.
   */
  capturedAtHasOffset: boolean
  exif: ExifData | null
  location: GeoPoint | null
  placeholderColor: string | null
  thumbnail: Buffer | null
  preview: Buffer | null
  error: string | null
}

export type PipelineOptions = {
  ffmpegPath: string
  ffprobePath: string
  /** `heif-dec` from libheif, used for tiled HEIC that ffmpeg mis-decodes. */
  heifDecPath: string
}

function emptyResult(type: AssetType, error: string | null = null): ProcessResult {
  return {
    type,
    width: null,
    height: null,
    duration: null,
    capturedAt: null,
    capturedAtHasOffset: false,
    exif: null,
    location: null,
    placeholderColor: null,
    thumbnail: null,
    preview: null,
    error,
  }
}

function toHex(r: number, g: number, b: number): string {
  return `#${[r, g, b].map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')}`
}

/** ffprobe writes `creation_time` as ISO-8601, normally already carrying its `Z`. */
function asDate(value: unknown): Date | null {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value
  if (typeof value === 'string') {
    const parsed = new Date(value)
    if (!Number.isNaN(parsed.getTime())) return parsed
  }
  return null
}

/**
 * `2026:08:04 16:52:52`, optionally with subseconds and, rarely, a zone written inline.
 *
 * EXIF specifies colons and a full time, but the reader this replaced went through
 * `new Date`, which was looser. Hyphenated dates, a bare date, and a trailing `UTC` (a
 * Picasa artifact) all reach real libraries, and tightening them into "no capture time"
 * would push those photographs onto their file mtime — a regression dressed as rigour.
 */
const EXIF_DATE =
  /^(\d{4})[:-](\d{2})[:-](\d{2})(?:[ T](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3})\d*)?)?\s*(Z|UTC|[+-]\d{2}:?\d{2})?$/

/** Minutes east of UTC. EXIF writes blanks when the camera never knew its offset. */
function offsetMinutes(value: unknown): number | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (trimmed === 'Z' || trimmed === 'UTC') return 0
  const match = /^([+-])(\d{2}):?(\d{2})$/.exec(trimmed)
  if (!match) return null
  const hours = Number(match[2])
  const minutes = Number(match[3])
  if (hours > 14 || minutes > 59) return null
  return (match[1] === '-' ? -1 : 1) * (hours * 60 + minutes)
}

/**
 * Resolves an EXIF wall clock against its companion offset tag.
 *
 * With an offset the pair names an instant and needs no interpretation. Without one there
 * is no way to place it, and the only reading that survives being moved between machines
 * is UTC — deriving it from the server's own zone makes the same file mean different
 * things in different deployments, which is the bug this replaced.
 */
export function exifInstant(
  value: unknown,
  offsetTag: unknown,
  subSeconds?: unknown,
): { at: Date; hasOffset: boolean } | null {
  if (typeof value !== 'string') return null
  const match = EXIF_DATE.exec(value.trim())
  if (!match) return null

  const [year, month, day] = match.slice(1, 4).map(Number)
  // A date with no time at all means midnight, which is what the old reader made of it.
  const [hour, minute, second] = match
    .slice(4, 7)
    .map((part) => (part === undefined ? 0 : Number(part)))
  // Date.UTC rolls anything out of range into a neighbouring day rather than refusing it,
  // so every field is checked before it is handed over. `0000:00:00 00:00:00` is how a
  // camera writes "no idea", `0001:01:01` is a spilled MinValue, and Date.UTC would read
  // both two-digit years as 19xx. The 31st of February is caught by the round trip below.
  if (year! < 1000 || month! < 1 || month! > 12 || day! < 1 || day! > 31) return null
  if (hour! > 23 || minute! > 59 || second! > 59) return null

  const milliseconds = subSecondMilliseconds(match[7] ?? subSeconds)
  const wall = Date.UTC(year!, month! - 1, day!, hour!, minute!, second!, milliseconds)
  const asWritten = new Date(wall)
  if (asWritten.getUTCMonth() !== month! - 1 || asWritten.getUTCDate() !== day!) return null

  const offset = offsetMinutes(match[8]) ?? offsetMinutes(offsetTag)
  return { at: new Date(wall - (offset ?? 0) * 60_000), hasOffset: offset !== null }
}

/**
 * EXIF keeps fractional seconds in a separate tag, as digits after an implied decimal
 * point: `421` is 421ms, `4` is 400ms. Dropping them would round a client's timestamp
 * down by up to a second for no reason.
 */
function subSecondMilliseconds(value: unknown): number {
  const digits = typeof value === 'number' ? String(value) : value
  if (typeof digits !== 'string') return 0
  const match = /^(\d{1,3})\d*$/.exec(digits.trim())
  return match ? Number(match[1]!.padEnd(3, '0')) : 0
}

export class MediaPipeline {
  constructor(private readonly options: PipelineOptions) {}

  classify(mimeType: string, filename: string): AssetType | null {
    if (mimeType.startsWith('image/')) return 'image'
    if (mimeType.startsWith('video/')) return 'video'
    const ext = extname(filename).toLowerCase()
    if (IMAGE_EXTENSIONS.has(ext)) return 'image'
    if (VIDEO_EXTENSIONS.has(ext)) return 'video'
    return null
  }

  async process(
    path: string,
    input: { mimeType: string; filename: string },
  ): Promise<ProcessResult> {
    const type = this.classify(input.mimeType, input.filename)
    if (!type) return emptyResult('image', `Unsupported file type: ${input.mimeType}`)
    return type === 'video' ? this.processVideo(path) : this.processImage(path)
  }

  private async processImage(path: string): Promise<ProcessResult> {
    const result = emptyResult('image')

    // EXIF is independent of decoding, so read it even if the pixels turn out unreadable.
    await this.readExif(path, result)

    const decoded = await decodeImage(path, {
      ffmpegPath: this.options.ffmpegPath,
      heifDecPath: this.options.heifDecPath,
    })
    if (!decoded) return { ...result, error: 'Could not decode this image' }

    result.width = decoded.width
    result.height = decoded.height

    try {
      await this.renderDerivatives(decoded.source, result)
    } catch (error) {
      return { ...result, error: `Could not render this image: ${(error as Error).message}` }
    }

    return result
  }

  /**
   * `rotate()` with no argument bakes in EXIF orientation, so no client ever rotates.
   * An ffmpeg-decoded PNG is already upright, so re-applying orientation would rotate twice.
   */
  private async renderDerivatives(
    source: Sharp,
    result: ProcessResult,
    applyOrientation = true,
  ): Promise<void> {
    const oriented = () => (applyOrientation ? source.clone().rotate() : source.clone())

    const thumbnail = await oriented()
      .resize(THUMBNAIL_EDGE, THUMBNAIL_EDGE, { fit: 'inside', withoutEnlargement: true })
      .webp({ quality: 72 })
      .toBuffer()
    const preview = await oriented()
      .resize(PREVIEW_EDGE, PREVIEW_EDGE, { fit: 'inside', withoutEnlargement: true })
      .webp({ quality: 82 })
      .toBuffer()

    result.thumbnail = thumbnail
    result.preview = preview
    result.placeholderColor = await this.dominantColor(thumbnail)

    // Report the dimensions the viewer will actually see, not the stored orientation.
    const shown = await sharp(preview).metadata()
    if (shown.width && shown.height && result.width && result.height) {
      const rotated = shown.width > shown.height !== result.width > result.height
      if (rotated) [result.width, result.height] = [result.height, result.width]
    }
  }

  private async processVideo(path: string): Promise<ProcessResult> {
    const result = emptyResult('video')

    const probe = await this.probe(path)
    if (probe) {
      result.width = probe.width
      result.height = probe.height
      result.duration = probe.duration
      result.capturedAt = probe.creationTime
      // Never anchored. ffprobe prints `creation_time` with a `Z` whether or not the
      // container held one, and phones routinely write a local wall clock into an mp4
      // `mvhd` box that the spec says is UTC. The `Z` is ffprobe's, not the camera's, so
      // it is not evidence of an offset and a client's own timestamp still outranks it.
      result.capturedAtHasOffset = false
    }

    // Seek a little way in: the first frame of a phone video is often black.
    const seek = probe?.duration && probe.duration > 1 ? Math.min(probe.duration / 3, 3) : 0
    const frame = await decodeWithFfmpeg(path, this.options.ffmpegPath, seek)
    if (!frame) return { ...result, error: 'Could not read a frame from this video' }

    try {
      // The extracted frame is already upright; ffmpeg applied any rotation metadata.
      await this.renderDerivatives(sharp(frame), result, false)
    } catch (error) {
      return { ...result, error: `Could not render a poster frame: ${(error as Error).message}` }
    }

    return result
  }

  private async readExif(path: string, result: ProcessResult): Promise<void> {
    // `reviveValues: false` keeps the date tags as the strings EXIF actually stores. Left
    // on, exifr hands back a Date it built in the server's own timezone, which silently
    // reintroduces the guess this code exists to avoid. It turns off revivers for a few
    // other tags too, none of which are read below; GPS is computed before that step.
    //
    // `translateValues: false` is a separate flag, and both are wanted. Left on, exifr
    // renders Orientation as "Rotate 90 CW" rather than 6, so the numeric guard below
    // never held and every asset ever ingested stored a null orientation. Of the tags
    // read here it changes that one alone: the dates, the GPS pair and the camera fields
    // come back identical either way.
    const parsed = await exifr
      .parse(path, {
        tiff: true,
        exif: true,
        gps: true,
        reviveValues: false,
        translateValues: false,
      })
      .catch(() => null)
    if (!parsed) return

    // Each date tag has its own offset companion, and they do not describe the same
    // moment, so the pairs must not be crossed.
    const captured =
      exifInstant(parsed.DateTimeOriginal, parsed.OffsetTimeOriginal, parsed.SubSecTimeOriginal) ??
      exifInstant(parsed.CreateDate, parsed.OffsetTimeDigitized, parsed.SubSecTimeDigitized) ??
      exifInstant(parsed.ModifyDate, parsed.OffsetTime, parsed.SubSecTime)
    result.capturedAt = captured?.at ?? null
    result.capturedAtHasOffset = captured?.hasOffset ?? false

    result.exif = {
      make: parsed.Make ?? null,
      model: parsed.Model ?? null,
      lens: parsed.LensModel ?? null,
      fNumber: parsed.FNumber ?? null,
      exposureTime: parsed.ExposureTime ?? null,
      iso: parsed.ISO ?? null,
      focalLength: parsed.FocalLength ?? null,
      /**
       * What the file said, not something for a client to apply: `renderDerivatives`
       * has already baked the rotation in and `width`/`height` are reported after it,
       * so a client that acts on this turns the photograph twice. It is here so a
       * client can tell "the camera wrote no orientation" from "the server dropped it".
       */
      orientation: typeof parsed.Orientation === 'number' ? parsed.Orientation : null,
    }

    // What a GPS block decodes to has to be tested for a value that locates something,
    // not for a type: see `coordinates.ts` for the two ways it fails to.
    if (isPlaceableLatitude(parsed.latitude) && isPlaceableLongitude(parsed.longitude)) {
      result.location = {
        latitude: parsed.latitude,
        longitude: parsed.longitude,
        altitude: isUsableAltitude(parsed.GPSAltitude) ? parsed.GPSAltitude : null,
        place: null,
      }
    }
  }

  private async dominantColor(webp: Buffer): Promise<string | null> {
    try {
      const { data } = await sharp(webp).resize(1, 1, { fit: 'cover' }).raw().toBuffer({
        resolveWithObject: true,
      })
      return toHex(data[0] ?? 0, data[1] ?? 0, data[2] ?? 0)
    } catch {
      return null
    }
  }

  private async probe(path: string) {
    const proc = Bun.spawn(
      [
        this.options.ffprobePath,
        '-v',
        'quiet',
        '-print_format',
        'json',
        '-show_format',
        '-show_streams',
        path,
      ],
      { stdout: 'pipe', stderr: 'ignore' },
    )
    const text = await new Response(proc.stdout).text()
    if ((await proc.exited) !== 0) return null

    try {
      const data = JSON.parse(text) as {
        streams?: Array<Record<string, unknown>>
        format?: Record<string, unknown>
      }
      const video = data.streams?.find((s) => s.codec_type === 'video')
      const duration = Number(data.format?.duration ?? video?.duration)
      const creation =
        (data.format?.tags as Record<string, string> | undefined)?.creation_time ??
        (video?.tags as Record<string, string> | undefined)?.creation_time
      return {
        width: typeof video?.width === 'number' ? video.width : null,
        height: typeof video?.height === 'number' ? video.height : null,
        duration: Number.isFinite(duration) ? duration : null,
        creationTime: creation ? asDate(creation) : null,
      }
    } catch {
      return null
    }
  }
}
