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

function fullBox(type: string, version: number, payload: Buffer): Buffer {
  const head = Buffer.alloc(4)
  head.writeUInt8(version, 0)
  return box(type, Buffer.concat([head, payload]))
}

/** `brands[0]` is the major brand; the rest are the compatible brands. */
function heifFtypBox(brands: string[]): Buffer {
  return box(
    'ftyp',
    Buffer.concat([
      Buffer.from(brands[0]!, 'ascii'),
      Buffer.from([0, 0, 0, 0]),
      Buffer.from(brands.slice(1).join(''), 'ascii'),
    ]),
  )
}

function pitmBox(id: number): Buffer {
  const payload = Buffer.alloc(2)
  payload.writeUInt16BE(id, 0)
  return fullBox('pitm', 0, payload)
}

type ItemRef = { kind: string; from: number; to: number[] }

function irefBox(refs: ItemRef[]): Buffer {
  const children = refs.map(({ kind, from, to }) => {
    const payload = Buffer.alloc(4 + to.length * 2)
    payload.writeUInt16BE(from, 0)
    payload.writeUInt16BE(to.length, 2)
    for (const [i, id] of to.entries()) payload.writeUInt16BE(id, 4 + i * 2)
    return box(kind, payload)
  })
  return fullBox('iref', 0, Buffer.concat(children))
}

type Extent = { offset: number; length: number }
type ItemLocation = {
  id: number
  construction: number
  extents: Extent[]
  /** Non-zero means the item's bytes live in another file. */
  dataReferenceIndex?: number
}

/** An `iloc` version 1 with 4-byte offsets and lengths and no base offset or extent index. */
function ilocBox(items: ItemLocation[]): Buffer {
  const head = Buffer.alloc(4)
  head.writeUInt8(0x44, 0) // offset_size = 4, length_size = 4
  head.writeUInt8(0x00, 1) // base_offset_size = 0, index_size = 0
  head.writeUInt16BE(items.length, 2)

  const entries = items.map((item) => {
    const buf = Buffer.alloc(8 + item.extents.length * 8)
    buf.writeUInt16BE(item.id, 0)
    buf.writeUInt16BE(item.construction, 2)
    buf.writeUInt16BE(item.dataReferenceIndex ?? 0, 4) // 0 means "this file"
    buf.writeUInt16BE(item.extents.length, 6)
    item.extents.forEach((extent, i) => {
      buf.writeUInt32BE(extent.offset, 8 + i * 8)
      buf.writeUInt32BE(extent.length, 12 + i * 8)
    })
    return buf
  })

  return fullBox('iloc', 1, Buffer.concat([head, ...entries]))
}

const GRID_DESCRIPTOR = Buffer.from([0x00, 0x00, 0x01, 0x01, 0x02, 0x00, 0x02, 0x00])

type HeifSpec = {
  tiles: Buffer[]
  xmp: Buffer
  /** An `auxl` item — a gain map or depth map — stored after the tiles. */
  aux?: Buffer
  brands?: string[]
  omitItemIndex?: boolean
  /** A second top-level `mdat` no item claims, the shape a motion photo's video takes. */
  trailer?: Buffer
  /** Give the XMP item, or the primary, a data reference into another file. */
  externalItem?: 'xmp' | 'primary'
  /** Extra items, each with `EXTENT_FLOOD_PER_ITEM` extents, for the extent bound. */
  floodExtentItems?: number
  /** A `moov`, which makes the file an image sequence rather than a still. */
  withTracks?: boolean
  /**
   * Extra `dimg` sub-boxes naming the primary, each listing `FLOOD_TARGETS` items. A single
   * sub-box cannot cross the reference bound — its count is a uint16 — so only a pile of them
   * reaches it, which is the shape a crafted file would take.
   */
  floodDimgBoxes?: number
}

const FLOOD_TARGETS = 30000
const EXTENT_FLOOD_PER_ITEM = 30000
const PRIMARY_ID = 1
const XMP_ID = 90
const AUX_ID = 91

/**
 * A HEIF shaped like the ones `sips` and iPhones write: a `grid` primary whose descriptor
 * lives in `idat`, its tiles and the XMP item side by side in `mdat`.
 */
function heif(spec: HeifSpec): Buffer {
  const ftyp = heifFtypBox(spec.brands ?? ['heic', 'mif1', 'heic'])
  const tileIds = spec.tiles.map((_, i) => 10 + i)
  const payloads = [...spec.tiles, spec.xmp, ...(spec.aux ? [spec.aux] : [])]

  // Offsets are fixed-width, so a first pass with zeros measures a `meta` of the final size.
  const build = (mdatPayloadStart: number): { meta: Buffer; mdat: Buffer } => {
    let cursor = mdatPayloadStart
    const extents = payloads.map((payload) => {
      const extent = { offset: cursor, length: payload.length }
      cursor += payload.length
      return extent
    })

    const extentFlood: ItemLocation[] = Array.from(
      { length: spec.floodExtentItems ?? 0 },
      (_, n) => ({
        id: 2000 + n,
        construction: 0,
        extents: Array.from({ length: EXTENT_FLOOD_PER_ITEM }, (_, i) => ({
          // Spaced out, so each extent leaves a gap behind it.
          offset: mdatPayloadStart + i * 2,
          length: 1,
        })),
      }),
    )

    const locations: ItemLocation[] = [
      ...extentFlood,
      {
        id: PRIMARY_ID,
        construction: 1,
        extents: [{ offset: 0, length: GRID_DESCRIPTOR.length }],
        dataReferenceIndex: spec.externalItem === 'primary' ? 1 : 0,
      },
      ...tileIds.map((id, i) => ({ id, construction: 0, extents: [extents[i]!] })),
      {
        id: XMP_ID,
        construction: 0,
        extents: [extents[spec.tiles.length]!],
        dataReferenceIndex: spec.externalItem === 'xmp' ? 1 : 0,
      },
      ...(spec.aux
        ? [{ id: AUX_ID, construction: 0, extents: [extents[spec.tiles.length + 1]!] }]
        : []),
    ]

    const flood = Array.from({ length: spec.floodDimgBoxes ?? 0 }, () => ({
      kind: 'dimg',
      from: PRIMARY_ID,
      // All naming one real tile, so the flood tests the reference bound rather than the
      // item bound, and the walk still has somewhere to go.
      to: Array.from({ length: FLOOD_TARGETS }, () => tileIds[0]!),
    }))
    const refs: ItemRef[] = [
      ...flood,
      { kind: 'dimg', from: PRIMARY_ID, to: tileIds },
      { kind: 'cdsc', from: XMP_ID, to: [PRIMARY_ID] },
      ...(spec.aux ? [{ kind: 'auxl', from: AUX_ID, to: [PRIMARY_ID] }] : []),
    ]

    const index = spec.omitItemIndex
      ? Buffer.alloc(0)
      : Buffer.concat([pitmBox(PRIMARY_ID), irefBox(refs), ilocBox(locations)])

    const tracks = spec.withTracks ? moovBox(Buffer.from('tracks')) : Buffer.alloc(0)
    return {
      meta: Buffer.concat([
        fullBox('meta', 0, Buffer.concat([index, box('idat', GRID_DESCRIPTOR)])),
        tracks,
      ]),
      mdat: box('mdat', Buffer.concat(payloads)),
    }
  }

  const measured = build(0)
  const final = build(ftyp.length + measured.meta.length + 8)
  const trailer = spec.trailer ? box('mdat', spec.trailer) : Buffer.alloc(0)
  return Buffer.concat([ftyp, final.meta, final.mdat, trailer])
}

describe('contentHash HEIF', () => {
  const tiles = [randomBytes(512), randomBytes(384), randomBytes(400), randomBytes(256)]

  test('is stable when a metadata rewrite resizes the XMP item inside mdat', async () => {
    const before = heif({ tiles, xmp: Buffer.from('<x:xmpmeta>rating 0</x:xmpmeta>') })
    const after = heif({ tiles, xmp: Buffer.from('<x:xmpmeta>rating 1, and longer</x:xmpmeta>') })

    const hash = await hashOf(before)
    expect(hash).not.toBeNull()
    expect(await hashOf(after)).toBe(hash)
  })

  test('differs for different tile bytes', async () => {
    const xmp = Buffer.from('<x:xmpmeta/>')
    const other = [...tiles.slice(0, 3), randomBytes(256)]
    expect(await hashOf(heif({ tiles: other, xmp }))).not.toBe(await hashOf(heif({ tiles, xmp })))
  })

  test('a copy missing a trailer no item claims does not collapse into the richer file', async () => {
    const xmp = Buffer.from('<x:xmpmeta/>')
    const withVideo = heif({ tiles, xmp, trailer: randomBytes(512) })
    expect(await hashOf(withVideo)).not.toBe(await hashOf(heif({ tiles, xmp })))
  })

  test('a trailer survives a metadata rewrite that resizes the XMP item', async () => {
    const trailer = randomBytes(512)
    const before = heif({ tiles, xmp: Buffer.from('<x/>'), trailer })
    const after = heif({ tiles, xmp: Buffer.from('<x>rewritten, and longer</x>'), trailer })
    const hash = await hashOf(before)
    expect(hash).not.toBeNull()
    expect(await hashOf(after)).toBe(hash)
  })

  test('a copy missing its auxiliary image does not collapse into the richer file', async () => {
    const xmp = Buffer.from('<x:xmpmeta/>')
    const aux = randomBytes(128)
    expect(await hashOf(heif({ tiles, xmp, aux }))).not.toBe(await hashOf(heif({ tiles, xmp })))
  })

  test('every HEIF-family brand takes the item route, major or compatible', async () => {
    const shortXmp = Buffer.from('<x/>')
    const longXmp = Buffer.from('<x>padded out a good deal further</x>')
    const brandSets = ['heic', 'heix', 'mif1', 'msf1', 'avif']
      .map((brand) => [brand])
      .concat([['isom', 'iso2', 'heic']])

    for (const brands of brandSets) {
      const hash = await hashOf(heif({ tiles, xmp: shortXmp, brands }))
      expect(hash).not.toBeNull()
      expect(await hashOf(heif({ tiles, xmp: longXmp, brands }))).toBe(hash)
    }
  })

  test('returns null when a HEIF brand carries no item index to walk', async () => {
    const xmp = Buffer.from('<x:xmpmeta/>')
    expect(await hashOf(heif({ tiles, xmp, omitItemIndex: true }))).toBeNull()
  })

  test('bounds the item references: an iref past the cap returns null', async () => {
    const xmp = Buffer.from('<x:xmpmeta/>')
    // Two floods stay under the 65536 cap, three cross it. The first assertion is also the
    // guard against merging those references quadratically: it does not finish if they are.
    expect(await hashOf(heif({ tiles, xmp, floodDimgBoxes: 2 }))).not.toBeNull()
    expect(await hashOf(heif({ tiles, xmp, floodDimgBoxes: 3 }))).toBeNull()
  })

  test('bounds the item extents: an iloc past the cap returns null', async () => {
    const xmp = Buffer.from('<x:xmpmeta/>')
    // Two flooded items stay under the 65536 cap, three cross it.
    expect(await hashOf(heif({ tiles, xmp, floodExtentItems: 2 }))).not.toBeNull()
    expect(await hashOf(heif({ tiles, xmp, floodExtentItems: 3 }))).toBeNull()
  }, 30000)

  test('an item in another file is skipped, not fatal, unless it is the picture', async () => {
    const shortXmp = Buffer.from('<x/>')
    const longXmp = Buffer.from('<x>rewritten, and rather longer</x>')

    // The XMP living elsewhere says nothing about whether the picture can be hashed. Its
    // bytes are no longer claimed, so they now count as payload and the rewrite shows up.
    const hash = await hashOf(heif({ tiles, xmp: shortXmp, externalItem: 'xmp' }))
    expect(hash).not.toBeNull()
    expect(await hashOf(heif({ tiles, xmp: longXmp, externalItem: 'xmp' }))).not.toBe(hash)

    expect(await hashOf(heif({ tiles, xmp: shortXmp, externalItem: 'primary' }))).toBeNull()
  })

  test('an image sequence keeps the mdat rule despite its cover item', async () => {
    const xmp = Buffer.from('<x:xmpmeta/>')
    const brands = ['msf1', 'msf1', 'avis']
    const a = heif({ tiles, xmp, brands, withTracks: true })
    const b = heif({
      tiles: [...tiles.slice(0, 3), randomBytes(400)],
      xmp,
      brands,
      withTracks: true,
    })
    expect(await hashOf(a)).not.toBeNull()
    expect(await hashOf(b)).not.toBe(await hashOf(a))
  })

  test('a non-HEIF brand keeps the mdat rule even with a meta box', async () => {
    const xmp = Buffer.from('<x:xmpmeta/>')
    const brands = ['isom', 'isom', 'iso2']
    const a = heif({ tiles, xmp, brands })
    const b = heif({ tiles, xmp: Buffer.from('<x:xmpmeta>longer</x:xmpmeta>'), brands })
    expect(await hashOf(a)).not.toBeNull()
    expect(await hashOf(b)).not.toBe(await hashOf(a))
  })
})

/** Whether a command exists on this machine, so a fixture can degrade instead of lying. */
async function hasCommand(command: string): Promise<boolean> {
  return (await Bun.spawn(['which', command], { stdout: 'ignore', stderr: 'ignore' }).exited) === 0
}

/*
 * Detected at module scope, not in beforeAll: `test.skipIf` is evaluated while the file is
 * being read, so a flag set later is always still false and every test silently skips.
 */
const realHeicAvailable = (await hasCommand('sips')) && (await hasCommand('exiftool'))

test.skipIf(!realHeicAvailable)(
  'a real HEIC survives an exiftool XMP rewrite',
  async () => {
    const png = join(workDir, 'real.png')
    await sharp({ create: { width: 512, height: 512, channels: 3, background: '#4a7' } })
      .png()
      .toFile(png)

    const original = join(workDir, 'real.heic')
    await Bun.$`sips -s format heic ${png} --out ${original}`.quiet().nothrow()
    // `sips` was found on this machine, so producing nothing is a failure, not a degradation.
    expect(await Bun.file(original).exists()).toBe(true)

    const rewritten = join(workDir, 'real-rewritten.heic')
    await Bun.write(rewritten, Bun.file(original))
    await Bun.$`exiftool -overwrite_original -XMP:Rating=1 ${rewritten}`.quiet().nothrow()

    // Without this the test is vacuous: an exiftool that refuses to write HEIC leaves a
    // byte-for-byte copy behind, and two identical files hash alike however broken the rule.
    const before = new Uint8Array(await Bun.file(original).arrayBuffer())
    const after = new Uint8Array(await Bun.file(rewritten).arrayBuffer())
    expect(sha256(after)).not.toBe(sha256(before))

    const hash = await contentHash(original)
    expect(hash).not.toBeNull()
    expect(await contentHash(rewritten)).toBe(hash)
  },
  30000,
)
