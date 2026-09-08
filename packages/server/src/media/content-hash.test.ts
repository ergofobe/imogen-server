import { afterAll, describe, expect, test } from 'bun:test'
import { createHash, randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import sharp from 'sharp'
import { contentHash } from './content-hash.ts'

const workDir = mkdtempSync(join(tmpdir(), 'imogen-content-hash-'))
afterAll(() => rmSync(workDir, { recursive: true, force: true }))

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

let hashOfCounter = 0

/** Writes `bytes` to a fresh file in workDir and hashes it, so tests can stay buffer-shaped. */
async function hashOf(bytes: Uint8Array): Promise<string | null> {
  const path = join(workDir, `hash-of-${hashOfCounter++}`)
  await Bun.write(path, bytes)
  return contentHash(path)
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

describe('contentHash JPEG', () => {
  test('is stable across metadata rewrites', async () => {
    const base = await makeJpeg('#888')
    const withCom = spliceAfterSoi(base, markerSegment(0xfe, Buffer.from('a comment', 'ascii')))
    const withApp1 = spliceAfterSoi(
      base,
      markerSegment(0xe1, Buffer.from('Exif\0\0fake-exif-payload', 'ascii')),
    )

    const baseHash = await hashOf(base)
    expect(baseHash).not.toBeNull()
    expect(await hashOf(withCom)).toBe(baseHash)
    expect(await hashOf(withApp1)).toBe(baseHash)

    if (hasLeadingAppOrCom(base)) {
      const stripped = Buffer.concat([base.subarray(0, 2), base.subarray(firstSegmentLength(base))])
      expect(await hashOf(stripped)).toBe(baseHash)
    }

    expect(baseHash).not.toBe(sha256(base))
  })

  test('differs for different pixels', async () => {
    const a = await makeJpeg('#888')
    const b = await makeJpeg('#123456')
    expect(await hashOf(a)).not.toBe(await hashOf(b))
  })

  test('a byte appended after EOI changes the hash', async () => {
    const base = await makeJpeg('#888')
    const withTrailer = Buffer.concat([base, Buffer.from([0x01])])
    expect(await hashOf(withTrailer)).not.toBe(await hashOf(base))
  })

  test('returns null for truncated scan data', async () => {
    const base = await makeJpeg('#888')
    const truncated = base.subarray(0, base.length - 100)
    expect(await hashOf(truncated)).toBeNull()
  })

  test('returns null for a bare SOI', async () => {
    expect(await hashOf(Buffer.from([0xff, 0xd8]))).toBeNull()
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

describe('contentHash ISO-BMFF', () => {
  test('is stable across different moov/udta bytes', async () => {
    const mdatPayload = randomBytes(256)
    const a = isoBmff(Buffer.from('one'), mdatPayload)
    const b = isoBmff(Buffer.from('a totally different udta payload'), mdatPayload)
    const hashA = await hashOf(a)
    expect(hashA).not.toBeNull()
    expect(await hashOf(b)).toBe(hashA)
  })

  test('differs for different mdat payload', async () => {
    const a = isoBmff(Buffer.from('one'), randomBytes(256))
    const b = isoBmff(Buffer.from('one'), randomBytes(256))
    expect(await hashOf(a)).not.toBe(await hashOf(b))
  })

  test('64-bit largesize mdat matches 32-bit form with same payload', async () => {
    const mdatPayload = randomBytes(256)
    const normal = isoBmff(Buffer.from('one'), mdatPayload, false)
    const large = isoBmff(Buffer.from('one'), mdatPayload, true)
    expect(await hashOf(large)).toBe(await hashOf(normal))
  })

  test('returns null when there is no mdat', async () => {
    const noMdat = Buffer.concat([ftypBox(), moovBox(Buffer.from('one'))])
    expect(await hashOf(noMdat)).toBeNull()
  })

  test('returns null when a box size runs past the end of the buffer', async () => {
    const bogusHeader = Buffer.alloc(8)
    bogusHeader.writeUInt32BE(1000, 0)
    bogusHeader.write('moov', 4, 'ascii')
    const truncated = Buffer.concat([ftypBox(), bogusHeader, Buffer.from('short')])
    expect(await hashOf(truncated)).toBeNull()
  })

  // Keep in sync with MAX_BOXES in content-hash.ts.
  const MAX_BOXES = 65536

  /** `count` minimal 8-byte 'free' boxes, built without per-box concatenation. */
  function freeBoxes(count: number): Buffer {
    const template = Buffer.alloc(8)
    template.writeUInt32BE(8, 0)
    template.write('free', 4, 'ascii')
    const buf = Buffer.alloc(8 * count)
    for (let i = 0; i < count; i++) template.copy(buf, i * 8)
    return buf
  }

  test('bounds the box walk: too many top-level boxes returns null', async () => {
    const bloated = Buffer.concat([
      ftypBox(),
      freeBoxes(MAX_BOXES + 1),
      box('mdat', Buffer.from('payload')),
    ])
    expect(await hashOf(bloated)).toBeNull()
  }, 20000)

  test('a few hundred boxes before mdat still hash like the plain ftyp+mdat form', async () => {
    const mdatPayload = randomBytes(64)
    const withFreeBoxes = Buffer.concat([ftypBox(), freeBoxes(300), box('mdat', mdatPayload)])
    const plain = Buffer.concat([ftypBox(), box('mdat', mdatPayload)])
    expect(await hashOf(withFreeBoxes)).toBe(await hashOf(plain))
  })
})

test('returns null for a PNG-ish buffer', async () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  expect(await hashOf(png)).toBeNull()
})
