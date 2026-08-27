import { extname } from 'node:path'
import type { Sharp } from 'sharp'
import sharp from 'sharp'

export type Decoded = {
  source: Sharp
  width: number
  height: number
  /** Which decoder produced the pixels. Useful when diagnosing a bad import. */
  via: 'sharp' | 'heif' | 'ffmpeg'
}

export type DecodeOptions = {
  ffmpegPath: string
  /** `heif-dec` from libheif. Handles tiled HEIC that some ffmpeg builds mis-decode. */
  heifDecPath: string
}

const HEIF_EXTENSIONS = new Set(['.heic', '.heif', '.hif', '.avci'])

/**
 * A decode is only acceptable if it produced roughly the pixels the file claims to hold.
 * iPhone HEICs are stored as a grid of 512×512 tiles, and some ffmpeg builds hand back a
 * single tile rather than the assembled image — a silent 3000×2000 → 512×512 downgrade
 * that looks like a successful import until someone opens the photo.
 */
function isPlausible(
  decoded: { width: number; height: number },
  declared: { width?: number | undefined; height?: number | undefined },
): boolean {
  if (!declared.width || !declared.height) return true
  return decoded.width >= declared.width * 0.9 && decoded.height >= declared.height * 0.9
}

/**
 * Produces something sharp can render from, whatever the source format.
 *
 * sharp's prebuilt binary parses HEIF containers but cannot decode HEVC-coded pixels,
 * which is what every iPhone produces. It reports metadata happily and then fails on
 * `toBuffer()` with "bad seek". RAW files fail earlier, at `metadata()`.
 *
 * So neither readable metadata nor a clean open proves the pixels are readable. Each
 * candidate decoder is tested by actually decoding, and its output is measured against
 * the dimensions the file declares.
 */
export async function decodeImage(path: string, options: DecodeOptions): Promise<Decoded | null> {
  // Metadata usually survives even when the pixels cannot be decoded, so it is the
  // yardstick for judging whether a decode came back complete.
  const declared = await sharp(path)
    .metadata()
    .catch(() => ({}) as { width?: number; height?: number })

  const native = await tryNative(path)
  if (native && isPlausible(native, declared)) return native

  if (HEIF_EXTENSIONS.has(extname(path).toLowerCase())) {
    const heif = await decodeHeif(path, options.heifDecPath)
    if (heif && isPlausible(heif, declared)) return heif
  }

  const png = await decodeWithFfmpeg(path, options.ffmpegPath)
  if (png) {
    const fromFfmpeg = await wrap(png, 'ffmpeg')
    // A correct-but-small image still beats no image, so an implausible decode is used
    // only once nothing better has worked.
    if (fromFfmpeg) return fromFfmpeg
  }

  return native
}

async function wrap(buffer: Buffer, via: Decoded['via']): Promise<Decoded | null> {
  const source = sharp(buffer)
  const meta = await source.metadata().catch(() => null)
  if (!meta?.width || !meta.height) return null
  return { source, width: meta.width, height: meta.height, via }
}

async function tryNative(path: string): Promise<Decoded | null> {
  try {
    const source = sharp(path, { failOn: 'error' })
    const meta = await source.metadata()
    if (!meta.width || !meta.height) return null
    // Decode one pixel. Cheap, and it proves the codec is actually available.
    await source.clone().resize(1, 1, { fit: 'fill' }).raw().toBuffer()
    return { source, width: meta.width, height: meta.height, via: 'sharp' }
  } catch {
    return null
  }
}

/**
 * libheif's own decoder, which assembles tiled HEIC correctly where ffmpeg may return a
 * single tile.
 *
 * The binary was renamed: libheif 1.18 and later ship `heif-dec`, earlier versions ship
 * `heif-convert`, and distributions are split across both. Trying each in turn costs one
 * failed spawn and saves every photo on the older ones.
 */
async function decodeHeif(path: string, configuredPath: string): Promise<Decoded | null> {
  const candidates = [...new Set([configuredPath, 'heif-dec', 'heif-convert'])]
  for (const binary of candidates) {
    const decoded = await runHeifDecoder(binary, path)
    if (decoded) return decoded
  }
  return null
}

async function runHeifDecoder(binary: string, path: string): Promise<Decoded | null> {
  const output = `${path}.decoded.png`
  try {
    const proc = Bun.spawn([binary, path, output], { stdout: 'ignore', stderr: 'ignore' })
    if ((await proc.exited) !== 0) return null
    const file = Bun.file(output)
    if (!(await file.exists())) return null
    return await wrap(Buffer.from(await file.arrayBuffer()), 'heif')
  } catch {
    // The binary is not installed on this machine; the caller tries the next one.
    return null
  } finally {
    await Bun.file(output)
      .delete()
      .catch(() => {})
  }
}

/** Decodes anything ffmpeg understands into a PNG buffer sharp can then work with. */
export async function decodeWithFfmpeg(
  path: string,
  ffmpegPath: string,
  seekSeconds = 0,
): Promise<Buffer | null> {
  const args = [ffmpegPath, '-loglevel', 'error']
  if (seekSeconds > 0) args.push('-ss', seekSeconds.toFixed(2))
  args.push('-i', path, '-frames:v', '1', '-f', 'image2pipe', '-vcodec', 'png', 'pipe:1')

  try {
    const proc = Bun.spawn(args, { stdout: 'pipe', stderr: 'ignore' })
    const buffer = Buffer.from(await new Response(proc.stdout).arrayBuffer())
    const code = await proc.exited
    if (code === 0 && buffer.length > 0) return buffer
    // Seeking past the end of a short clip yields nothing; retry from the start.
    return seekSeconds > 0 ? decodeWithFfmpeg(path, ffmpegPath, 0) : null
  } catch {
    // ffmpeg is not installed here, or IMOGEN_FFMPEG_PATH points at nothing. Letting the
    // spawn throw would abandon the whole ingest, including the photographs sharp had
    // already decoded perfectly well; a server without ffmpeg should lose RAW and video,
    // not everything.
    return null
  }
}
