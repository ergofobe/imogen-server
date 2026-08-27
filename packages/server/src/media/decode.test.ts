import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import sharp from 'sharp'
import { decodeImage, decodeWithFfmpeg, openOriginal } from './decode.ts'

const workDir = mkdtempSync(join(tmpdir(), 'imogen-decode-'))
afterAll(() => rmSync(workDir, { recursive: true, force: true }))

const options = { ffmpegPath: 'ffmpeg', heifDecPath: 'heif-dec' }

/** A gradient, which compresses to enough scan data that chopping it leaves a real image. */
async function jpegBytes(width: number, height: number): Promise<Buffer> {
  const raw = Buffer.alloc(width * height * 3)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 3
      raw[i] = Math.floor((x / width) * 255)
      raw[i + 1] = Math.floor((y / height) * 255)
      raw[i + 2] = (x ^ y) & 0xff
    }
  }
  return sharp(raw, { raw: { width, height, channels: 3 } })
    .jpeg({ quality: 90 })
    .toBuffer()
}

/** An upload that died mid-transfer: a valid header, and then the bytes just stop. */
async function truncatedJpeg(name: string, keep = 0.7): Promise<string> {
  const full = await jpegBytes(1600, 1200)
  const path = join(workDir, name)
  writeFileSync(path, full.subarray(0, Math.floor(full.length * keep)))
  return path
}

describe('the ffmpeg fallback', () => {
  test('reports nothing rather than throwing when ffmpeg is not installed', async () => {
    // Bun.spawn throws ENOENT for a bare name that is not on PATH, which is exactly how
    // this goes wrong in production: a container built without ffmpeg, or an
    // IMOGEN_FFMPEG_PATH pointing at nothing. An escaping throw abandons the whole
    // ingest, including the photographs sharp had already decoded perfectly well — so a
    // server without ffmpeg would store nothing at all rather than losing only RAW and
    // video.
    const decoded = await decodeWithFfmpeg('/dev/null', 'imogen-no-such-ffmpeg')
    expect(decoded).toBeNull()
  })
})

describe('a truncated jpeg', () => {
  /*
   * libvips calls a premature end of scan data fatal at every failOn level except 'none',
   * so a half-uploaded photograph used to reach the caller as a raw
   * "VipsJpeg: premature end of JPEG image" throw. The rows that did arrive are worth
   * keeping, so the decode has to come back with pixels.
   */
  test('decodes to the rows that did arrive', async () => {
    const path = await truncatedJpeg('cut.jpg')

    const decoded = await decodeImage(path, options)

    expect(decoded).not.toBeNull()
    expect(decoded!.width).toBe(1600)
    expect(decoded!.height).toBe(1200)
  })

  test('is salvaged by sharp itself, without spawning ffmpeg', async () => {
    const path = await truncatedJpeg('cut-native.jpg')

    const decoded = await decodeImage(path, options)

    expect(decoded!.via).toBe('sharp')
  })

  test('renders, rather than throwing partway through', async () => {
    const path = await truncatedJpeg('cut-render.jpg')

    const decoded = await decodeImage(path, options)
    const webp = await decoded!.source.clone().resize(320, 320, { fit: 'inside' }).webp().toBuffer()

    expect((await sharp(webp).metadata()).format).toBe('webp')
  })
})

describe('a truncated png', () => {
  test('is salvaged by sharp itself, without spawning ffmpeg', async () => {
    // The same half-uploaded file, in the other format the browser uploader produces.
    const raw = Buffer.alloc(1200 * 900 * 3)
    for (let i = 0; i < raw.length; i++) raw[i] = ((i * 2654435761) >>> 13) & 0xff
    const full = await sharp(raw, { raw: { width: 1200, height: 900, channels: 3 } })
      .png()
      .toBuffer()
    const path = join(workDir, 'cut.png')
    writeFileSync(path, full.subarray(0, Math.floor(full.length * 0.7)))

    const decoded = await decodeImage(path, options)

    expect(decoded!.via).toBe('sharp')
    expect(decoded!.width).toBe(1200)
  })
})

describe('opening an original', () => {
  /*
   * Face detection, alignment, and the face-crop endpoint all read the original file
   * directly rather than a derivative. Opening it any other way brings back libvips'
   * default strictness, and a truncated photograph turns a face crop into a 500 carrying
   * "VipsJpeg: premature end of JPEG image" out to the client.
   */
  test('reads pixels from a truncated file rather than throwing', async () => {
    const path = await truncatedJpeg('cut-open.jpg')

    const { data, info } = await openOriginal(path)
      .resize(64, 64, { fit: 'fill' })
      .raw()
      .toBuffer({ resolveWithObject: true })

    expect(info.width).toBe(64)
    expect(data.length).toBeGreaterThan(0)
  })

  test('still refuses a file that is not an image', async () => {
    const path = join(workDir, 'prose.jpg')
    writeFileSync(path, Buffer.from('this is not a photograph, it is prose'))

    expect(openOriginal(path).metadata()).rejects.toThrow()
  })
})

describe('a file that holds no image at all', () => {
  /*
   * Tolerating truncation must not turn into tolerating anything: the fallback chain
   * still has to end in a refusal, or a corrupt upload becomes an asset with garbage
   * pixels instead of an honest failure.
   */
  test('is refused rather than decoded into something', async () => {
    const path = join(workDir, 'not-an-image.jpg')
    writeFileSync(path, Buffer.from('this is not a photograph, it is prose'))

    expect(await decodeImage(path, options)).toBeNull()
  })
})
