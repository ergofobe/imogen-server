import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import sharp from 'sharp'
import { MediaPipeline } from './pipeline.ts'
import { hashFile, LocalStorage } from './storage.ts'

const workDir = mkdtempSync(join(tmpdir(), 'imogen-media-'))
const storage = new LocalStorage(join(workDir, 'store'))
const pipeline = new MediaPipeline({
  ffmpegPath: 'ffmpeg',
  ffprobePath: 'ffprobe',
  heifDecPath: 'heif-dec',
})

afterAll(() => rmSync(workDir, { recursive: true, force: true }))

/** A gradient, so a resized copy is still visually distinguishable from a flat fill. */
async function makeJpeg(path: string, width = 1600, height = 1200) {
  const raw = Buffer.alloc(width * height * 3)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 3
      raw[i] = Math.floor((x / width) * 255)
      raw[i + 1] = Math.floor((y / height) * 255)
      raw[i + 2] = 128
    }
  }
  await sharp(raw, { raw: { width, height, channels: 3 } })
    .jpeg()
    .toFile(path)
  return path
}

/** Whether a command exists on this machine, so a fixture can degrade instead of lying. */
async function hasCommand(command: string): Promise<boolean> {
  return (await Bun.spawn(['which', command], { stdout: 'ignore', stderr: 'ignore' }).exited) === 0
}

/**
 * Encodes a HEIC. macOS has `sips`; Linux has `heif-enc` from libheif. Neither is
 * universal, so a machine with neither skips the HEIC tests rather than failing them
 * for the wrong reason.
 */
async function encodeHeic(source: string, out: string): Promise<boolean> {
  if (heicEncoder === 'sips') {
    await Bun.$`sips -s format heic ${source} --out ${out}`.quiet().nothrow()
  } else if (heicEncoder === 'heif-enc') {
    await Bun.$`heif-enc -q 80 -o ${out} ${source}`.quiet().nothrow()
  } else {
    return false
  }
  return Bun.file(out).exists()
}

let jpegPath: string
let heicPath: string
let videoPath: string

/*
 * Detected at module scope, not in beforeAll: `test.skipIf` is evaluated while the file
 * is being read, so a flag set later is always still false and every test silently skips.
 */
const heicEncoder = (await hasCommand('sips'))
  ? 'sips'
  : (await hasCommand('heif-enc'))
    ? 'heif-enc'
    : null
const exiftoolAvailable = await hasCommand('exiftool')

/**
 * A large HEIC, built once at module scope. `test.skipIf` is evaluated while this file is
 * read, so anything it depends on has to exist by then — and encoding can fail outright
 * on a machine whose HEVC encoder is unusable, which is a missing fixture rather than a
 * defect in the decoder under test.
 */
const tiledHeicPath = join(workDir, 'tiled.heic')
const tiledHeicAvailable = await (async () => {
  if (heicEncoder === null) return false
  const source = join(workDir, 'tiled-source.jpg')
  await makeJpeg(source, 3000, 2000)
  return encodeHeic(source, tiledHeicPath)
})()

beforeAll(async () => {
  jpegPath = await makeJpeg(join(workDir, 'photo.jpg'))

  heicPath = join(workDir, 'photo.heic')
  await encodeHeic(jpegPath, heicPath)

  videoPath = join(workDir, 'clip.mp4')
  await Bun.$`ffmpeg -y -loglevel error -f lavfi -i testsrc=duration=2:size=640x480:rate=24 -pix_fmt yuv420p ${videoPath}`
    .quiet()
    .nothrow()
})

describe('format classification', () => {
  test('recognises an image by mime type', () => {
    expect(pipeline.classify('image/jpeg', 'a.jpg')).toBe('image')
  })

  test('recognises a video by mime type', () => {
    expect(pipeline.classify('video/mp4', 'a.mp4')).toBe('video')
  })

  test('falls back to the extension when the mime type is generic', () => {
    expect(pipeline.classify('application/octet-stream', 'IMG_0001.HEIC')).toBe('image')
    expect(pipeline.classify('application/octet-stream', 'IMG_0001.MOV')).toBe('video')
    expect(pipeline.classify('application/octet-stream', 'raw.CR2')).toBe('image')
  })

  test('rejects a format that is neither image nor video', () => {
    expect(pipeline.classify('application/pdf', 'contract.pdf')).toBeNull()
  })
})

describe('image processing', () => {
  test('produces a thumbnail and a preview from a jpeg', async () => {
    const result = await pipeline.process(jpegPath, {
      mimeType: 'image/jpeg',
      filename: 'photo.jpg',
    })

    expect(result.type).toBe('image')
    expect(result.width).toBe(1600)
    expect(result.height).toBe(1200)
    expect(result.thumbnail).not.toBeNull()
    expect(result.preview).not.toBeNull()
  })

  test('bounds the thumbnail to 320px on its long edge', async () => {
    const result = await pipeline.process(jpegPath, {
      mimeType: 'image/jpeg',
      filename: 'photo.jpg',
    })

    const meta = await sharp(result.thumbnail!).metadata()
    expect(Math.max(meta.width!, meta.height!)).toBe(320)
  })

  test('does not upscale an image smaller than the preview bound', async () => {
    const small = await makeJpeg(join(workDir, 'small.jpg'), 200, 150)

    const result = await pipeline.process(small, { mimeType: 'image/jpeg', filename: 'small.jpg' })

    const meta = await sharp(result.preview!).metadata()
    expect(meta.width).toBe(200)
  })

  test('emits webp derivatives, whatever went in', async () => {
    const result = await pipeline.process(jpegPath, {
      mimeType: 'image/jpeg',
      filename: 'photo.jpg',
    })

    expect((await sharp(result.thumbnail!).metadata()).format).toBe('webp')
    expect((await sharp(result.preview!).metadata()).format).toBe('webp')
  })

  test('extracts a placeholder colour for the grid', async () => {
    const result = await pipeline.process(jpegPath, {
      mimeType: 'image/jpeg',
      filename: 'photo.jpg',
    })

    expect(result.placeholderColor).toMatch(/^#[0-9a-f]{6}$/)
  })

  test.skipIf(heicEncoder === null)('reads a HEIC photo from an iPhone', async () => {
    const result = await pipeline.process(heicPath, {
      mimeType: 'image/heic',
      filename: 'IMG_0001.HEIC',
    })

    expect(result.type).toBe('image')
    expect(result.width).toBeGreaterThan(0)
    expect(result.thumbnail).not.toBeNull()
  })

  test.skipIf(!tiledHeicAvailable)(
    'decodes a tiled HEIC at full resolution, not one tile',
    async () => {
      // iPhone HEICs are a grid of 512x512 tiles. Some ffmpeg builds return a single tile
      // instead of the assembled image, which imports a 3000x2000 photo as 512x512 and
      // looks like a success. The decoded size must match what the file declares.
      const large = join(workDir, 'tiled.jpg')
      await makeJpeg(large, 3000, 2000)
      const tiled = join(workDir, 'tiled.heic')
      await encodeHeic(large, tiled)

      const declared = await sharp(tiled).metadata()
      const result = await pipeline.process(tiled, {
        mimeType: 'image/heic',
        filename: 'IMG_0002.HEIC',
      })

      expect(result.error).toBeNull()
      expect(result.width).toBeGreaterThanOrEqual(Math.floor(declared.width! * 0.9))
      expect(result.height).toBeGreaterThanOrEqual(Math.floor(declared.height! * 0.9))
    },
  )

  test('applies EXIF orientation so clients never have to rotate', async () => {
    const rotated = join(workDir, 'rotated.jpg')
    // Orientation 6 means "rotate 90° clockwise to display", so 1600x1200 shows as 1200x1600.
    await sharp(jpegPath).withMetadata({ orientation: 6 }).toFile(rotated)

    const result = await pipeline.process(rotated, {
      mimeType: 'image/jpeg',
      filename: 'rotated.jpg',
    })

    const meta = await sharp(result.preview!).metadata()
    expect(meta.height).toBeGreaterThan(meta.width!)
  })
})

describe('metadata extraction', () => {
  test.skipIf(!exiftoolAvailable)('reads capture time and camera from EXIF', async () => {
    // exiftool writes in place; `-o` would consume the source we share with other tests.
    const withExif = join(workDir, 'exif.jpg')
    await Bun.write(withExif, Bun.file(jpegPath))
    await Bun.$`exiftool -overwrite_original "-DateTimeOriginal=2019:07:04 11:22:33" "-Make=Apple" "-Model=iPhone 11" ${withExif}`
      .quiet()
      .nothrow()

    const result = await pipeline.process(withExif, {
      mimeType: 'image/jpeg',
      filename: 'exif.jpg',
    })

    expect(result.capturedAt?.getUTCFullYear()).toBe(2019)
    expect(result.exif?.make).toBe('Apple')
    expect(result.exif?.model).toBe('iPhone 11')
  })

  test.skipIf(!exiftoolAvailable)('reads GPS coordinates when present', async () => {
    const withGps = join(workDir, 'gps.jpg')
    await Bun.write(withGps, Bun.file(jpegPath))
    await Bun.$`exiftool -overwrite_original -GPSLatitude=38.7223 -GPSLatitudeRef=N -GPSLongitude=9.1393 -GPSLongitudeRef=W ${withGps}`
      .quiet()
      .nothrow()

    const result = await pipeline.process(withGps, { mimeType: 'image/jpeg', filename: 'gps.jpg' })

    expect(result.location?.latitude).toBeCloseTo(38.7223, 2)
    expect(result.location?.longitude).toBeCloseTo(-9.1393, 2)
  })

  test('reports no capture time rather than inventing one', async () => {
    const result = await pipeline.process(jpegPath, {
      mimeType: 'image/jpeg',
      filename: 'photo.jpg',
    })

    expect(result.capturedAt).toBeNull()
  })
})

describe('video processing', () => {
  test('extracts dimensions, duration, and a poster frame', async () => {
    const result = await pipeline.process(videoPath, {
      mimeType: 'video/mp4',
      filename: 'clip.mp4',
    })

    expect(result.type).toBe('video')
    expect(result.width).toBe(640)
    expect(result.height).toBe(480)
    expect(result.duration).toBeCloseTo(2, 0)
    expect(result.thumbnail).not.toBeNull()
    expect((await sharp(result.thumbnail!).metadata()).format).toBe('webp')
  })
})

describe('failure handling', () => {
  test('reports a decode failure instead of throwing', async () => {
    const junk = join(workDir, 'junk.jpg')
    await Bun.write(junk, 'this is definitely not a jpeg')

    const result = await pipeline.process(junk, { mimeType: 'image/jpeg', filename: 'junk.jpg' })

    expect(result.error).toBeString()
    expect(result.thumbnail).toBeNull()
  })
})

describe('a half-uploaded photograph', () => {
  /*
   * An upload that dies mid-transfer leaves a valid JPEG header followed by a partial
   * scan. The rows that arrived are a real photograph, so it belongs in the library —
   * not marked failed because the tail is missing.
   */
  test('still yields derivatives from the rows that arrived', async () => {
    const truncated = join(workDir, 'truncated.jpg')
    const full = await Bun.file(jpegPath).arrayBuffer()
    await Bun.write(truncated, new Uint8Array(full).subarray(0, Math.floor(full.byteLength * 0.7)))

    const result = await pipeline.process(truncated, {
      mimeType: 'image/jpeg',
      filename: 'truncated.jpg',
    })

    expect(result.error).toBeNull()
    expect(result.thumbnail).not.toBeNull()
    expect(result.preview).not.toBeNull()
    expect(result.width).toBe(1600)
    expect(result.height).toBe(1200)
  })
})

describe('storage', () => {
  test('round-trips a file through the local driver', async () => {
    const stored = await storage.write('a/b/c.txt', 'hello')

    expect(stored.sizeBytes).toBe(5)
    expect(await (await storage.read('a/b/c.txt')).text()).toBe('hello')
  })

  test('refuses a path that escapes the storage root', async () => {
    await expect(storage.write('../../escaped.txt', 'nope')).rejects.toThrow(
      'outside the storage root',
    )
  })

  test('hashes a file the same way twice', async () => {
    expect(await hashFile(jpegPath)).toBe(await hashFile(jpegPath))
    expect(await hashFile(jpegPath)).toHaveLength(64)
  })
})
