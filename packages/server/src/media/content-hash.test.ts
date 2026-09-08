import { afterAll, describe, expect, test } from 'bun:test'
import { createHash, randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import sharp from 'sharp'
import { contentHash, contentHashOf } from './content-hash.ts'

const workDir = mkdtempSync(join(tmpdir(), 'imogen-content-hash-'))
afterAll(() => rmSync(workDir, { recursive: true, force: true }))

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

async function makeJpeg(fill: string): Promise<Buffer> {
  return sharp({ create: { width: 32, height: 32, channels: 3, background: fill } })
    .jpeg()
    .toBuffer()
}

/** Splices a marker segment (with its own length header) in right after SOI. */
function spliceAfterSoi(jpeg: Buffer, segment: Buffer): Buffer {
  return Buffer.concat([jpeg.subarray(0, 2), segment, jpeg.subarray(2)])
}

function markerSegment(marker: number, payload: Buffer): Buffer {
  const length = payload.length + 2
  return Buffer.concat([
    Buffer.from([0xff, marker]),
    Buffer.from([length >> 8, length & 0xff]),
    payload,
  ])
}

/** True if the buffer starts with an APPn or COM segment right after SOI. */
function hasLeadingAppOrCom(jpeg: Buffer): boolean {
  const marker = jpeg[3]
  return marker !== undefined && ((marker >= 0xe0 && marker <= 0xef) || marker === 0xfe)
}

/** Length (in bytes, including SOI) of the first marker segment after SOI, for removal. */
function firstSegmentLength(jpeg: Buffer): number {
  const length = (jpeg[4]! << 8) | jpeg[5]!
  return 2 + length
}

describe('contentHashOf JPEG', () => {
  test('is stable across metadata rewrites', async () => {
    const base = await makeJpeg('#888')
    const withCom = spliceAfterSoi(base, markerSegment(0xfe, Buffer.from('a comment', 'ascii')))
    const withApp1 = spliceAfterSoi(
      base,
      markerSegment(0xe1, Buffer.from('Exif\0\0fake-exif-payload', 'ascii')),
    )

    const baseHash = contentHashOf(base)
    expect(baseHash).not.toBeNull()
    expect(contentHashOf(withCom)).toBe(baseHash)
    expect(contentHashOf(withApp1)).toBe(baseHash)

    if (hasLeadingAppOrCom(base)) {
      const stripped = Buffer.concat([base.subarray(0, 2), base.subarray(firstSegmentLength(base))])
      expect(contentHashOf(stripped)).toBe(baseHash)
    }

    expect(baseHash).not.toBe(sha256(base))
  })

  test('differs for different pixels', async () => {
    const a = await makeJpeg('#888')
    const b = await makeJpeg('#123456')
    expect(contentHashOf(a)).not.toBe(contentHashOf(b))
  })

  test('ignores bytes appended after EOI', async () => {
    const base = await makeJpeg('#888')
    const withTrailer = Buffer.concat([base, Buffer.from([0x01])])
    expect(contentHashOf(withTrailer)).toBe(contentHashOf(base))
  })

  test('returns null for truncated scan data', async () => {
    const base = await makeJpeg('#888')
    const truncated = base.subarray(0, base.length - 100)
    expect(contentHashOf(truncated)).toBeNull()
  })

  test('returns null for a bare SOI', () => {
    expect(contentHashOf(Buffer.from([0xff, 0xd8]))).toBeNull()
  })
})

function box(type: string, payload: Buffer): Buffer {
  const size = 8 + payload.length
  const header = Buffer.alloc(8)
  header.writeUInt32BE(size, 0)
  header.write(type, 4, 'ascii')
  return Buffer.concat([header, payload])
}

function largesizeBox(type: string, payload: Buffer): Buffer {
  const header = Buffer.alloc(16)
  header.writeUInt32BE(1, 0)
  header.write(type, 4, 'ascii')
  const size = BigInt(16 + payload.length)
  header.writeBigUInt64BE(size, 8)
  return Buffer.concat([header, payload])
}

function ftypBox(): Buffer {
  const payload = Buffer.concat([
    Buffer.from('isom', 'ascii'),
    Buffer.from([0, 0, 0, 0]),
    Buffer.from('isomiso2', 'ascii'),
  ])
  return box('ftyp', payload)
}

function moovBox(udtaBytes: Buffer): Buffer {
  return box('moov', box('udta', udtaBytes))
}

function isoBmff(udtaBytes: Buffer, mdatPayload: Buffer, useLargesize = false): Buffer {
  const mdat = useLargesize ? largesizeBox('mdat', mdatPayload) : box('mdat', mdatPayload)
  return Buffer.concat([ftypBox(), moovBox(udtaBytes), mdat])
}

describe('contentHashOf ISO-BMFF', () => {
  test('is stable across different moov/udta bytes', async () => {
    const mdatPayload = randomBytes(256)
    const a = isoBmff(Buffer.from('one'), mdatPayload)
    const b = isoBmff(Buffer.from('a totally different udta payload'), mdatPayload)
    const hashA = contentHashOf(a)
    expect(hashA).not.toBeNull()
    expect(contentHashOf(b)).toBe(hashA)
  })

  test('differs for different mdat payload', () => {
    const a = isoBmff(Buffer.from('one'), randomBytes(256))
    const b = isoBmff(Buffer.from('one'), randomBytes(256))
    expect(contentHashOf(a)).not.toBe(contentHashOf(b))
  })

  test('64-bit largesize mdat matches 32-bit form with same payload', () => {
    const mdatPayload = randomBytes(256)
    const normal = isoBmff(Buffer.from('one'), mdatPayload, false)
    const large = isoBmff(Buffer.from('one'), mdatPayload, true)
    expect(contentHashOf(large)).toBe(contentHashOf(normal))
  })

  test('returns null when there is no mdat', () => {
    const noMdat = Buffer.concat([ftypBox(), moovBox(Buffer.from('one'))])
    expect(contentHashOf(noMdat)).toBeNull()
  })

  test('returns null when a box size runs past the end of the buffer', () => {
    const bogusHeader = Buffer.alloc(8)
    bogusHeader.writeUInt32BE(1000, 0)
    bogusHeader.write('moov', 4, 'ascii')
    const truncated = Buffer.concat([ftypBox(), bogusHeader, Buffer.from('short')])
    expect(contentHashOf(truncated)).toBeNull()
  })
})

test('returns null for a PNG-ish buffer', () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  expect(contentHashOf(png)).toBeNull()
})

describe('contentHash (path-based)', () => {
  test('matches contentHashOf for a JPEG file on disk', async () => {
    const jpeg = await makeJpeg('#888')
    const path = join(workDir, 'photo.jpg')
    await Bun.write(path, jpeg)
    expect(await contentHash(path)).toBe(contentHashOf(jpeg))
  })

  test('matches contentHashOf for an ISO-BMFF file on disk', async () => {
    const bmff = isoBmff(Buffer.from('one'), randomBytes(4096))
    const path = join(workDir, 'video.mp4')
    await Bun.write(path, bmff)
    expect(await contentHash(path)).toBe(contentHashOf(bmff))
  })
})
