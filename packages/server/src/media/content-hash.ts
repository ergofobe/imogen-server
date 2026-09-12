import { createHash, type Hash } from 'node:crypto'
import { type FileHandle, open, stat } from 'node:fs/promises'

const MAX_JPEG_BYTES = 256 * 1024 * 1024
const READ_CHUNK_BYTES = 1024 * 1024
// A long fragmented recording is a few thousand moof/mdat pairs; this is generous headroom
// against a crafted file of millions of 8-byte boxes that would otherwise pin the request.
const MAX_BOXES = 65536

/**
 * Brands whose picture is built from `meta` items rather than tracks. In these the Exif and
 * XMP are items too, and their bytes sit in `mdat` beside the image tiles, so the whole-`mdat`
 * rule below would make a metadata rewrite look like a different photograph.
 */
const HEIF_BRANDS = new Set(['heic', 'heix', 'mif1', 'msf1', 'avif'])
const MAX_FTYP_BYTES = 1024
const MAX_META_BYTES = 16 * 1024 * 1024
const MAX_ITEMS = 4096

const SOI = 0xd8
const EOI = 0xd9
const SOS = 0xda
const TEM = 0x01
const RST0 = 0xd0
const RST7 = 0xd7
const APP0 = 0xe0
const APP15 = 0xef
const COM = 0xfe

function isStandaloneMarker(marker: number): boolean {
  return marker === TEM || (marker >= RST0 && marker <= RST7)
}

function isAppOrCom(marker: number): boolean {
  return (marker >= APP0 && marker <= APP15) || marker === COM
}

/** Length, in bytes from just after SOS's header, of the entropy-coded scan that follows it. */
function scanLength(bytes: Uint8Array, scanStart: number): number | null {
  let i = scanStart
  while (i < bytes.length - 1) {
    if (bytes[i] === 0xff) {
      const next = bytes[i + 1]!
      // `FF 00` is a stuffed byte, `FF FF` is fill, RSTn separates scan chunks: all part of the scan.
      if (next !== 0x00 && next !== 0xff && !(next >= RST0 && next <= RST7)) {
        return i - scanStart
      }
    }
    i++
  }
  return null
}

/**
 * Hashes everything but the APPn/COM segments, since those are exactly what re-export
 * pipelines rewrite (thumbnails, GPS, software tags) while leaving the picture untouched.
 */
function hashJpeg(bytes: Uint8Array): string | null {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== SOI) return null

  const hash = createHash('sha256')
  let i = 2

  while (true) {
    if (i + 1 >= bytes.length || bytes[i] !== 0xff) return null
    const marker = bytes[i + 1]!
    if (marker === EOI) {
      // A Pixel Ultra HDR JPEG carries its gain map as an MPF second image after EOI, and a
      // motion photo carries its video there. A copy missing that trailer is a poorer file,
      // not the same one, so it must not silently collapse into the richer file's hash.
      hash.update(bytes.subarray(i))
      return hash.digest('hex')
    }

    if (isStandaloneMarker(marker)) {
      hash.update(bytes.subarray(i, i + 2))
      i += 2
      continue
    }

    if (i + 3 >= bytes.length) return null
    const length = (bytes[i + 2]! << 8) | bytes[i + 3]!
    if (length < 2 || i + 2 + length > bytes.length) return null
    const segmentEnd = i + 2 + length

    if (marker === SOS) {
      const scanBytes = scanLength(bytes, segmentEnd)
      if (scanBytes === null) return null
      hash.update(bytes.subarray(i, segmentEnd + scanBytes))
      i = segmentEnd + scanBytes
      continue
    }

    if (!isAppOrCom(marker)) hash.update(bytes.subarray(i, segmentEnd))
    i = segmentEnd
  }
}

type BoxHeader = { type: string; payloadStart: number; payloadEnd: number }

/** Reads one box header at `offset`, or null if it is malformed or runs past `fileSize`. */
function readBoxHeader(header: Buffer, offset: number, fileSize: number): BoxHeader | null {
  if (header.length < 8) return null
  const size32 = header.readUInt32BE(0)
  const type = header.toString('ascii', 4, 8)

  if (size32 === 1) {
    if (header.length < 16) return null
    const size64 = header.readBigUInt64BE(8)
    if (size64 < 16n) return null
    const payloadStart = offset + 16
    const payloadEnd = offset + Number(size64)
    if (payloadEnd > fileSize) return null
    return { type, payloadStart, payloadEnd }
  }

  if (size32 === 0) {
    return { type, payloadStart: offset + 8, payloadEnd: fileSize }
  }

  if (size32 < 8) return null
  const payloadEnd = offset + size32
  if (payloadEnd > fileSize) return null
  return { type, payloadStart: offset + 8, payloadEnd }
}

async function streamRangeInto(
  handle: FileHandle,
  hash: Hash,
  start: number,
  end: number,
): Promise<void> {
  const buffer = Buffer.alloc(Math.min(READ_CHUNK_BYTES, end - start))
  let position = start
  while (position < end) {
    const toRead = Math.min(READ_CHUNK_BYTES, end - position)
    const { bytesRead } = await handle.read(buffer, 0, toRead, position)
    if (bytesRead === 0) throw new Error('unexpected end of file while hashing a range')
    hash.update(buffer.subarray(0, bytesRead))
    position += bytesRead
  }
}

/** Fills `length` bytes of `buf` from `position`; false at end of file. A short read is legal. */
async function readExact(
  handle: FileHandle,
  buf: Buffer,
  length: number,
  position: number,
): Promise<boolean> {
  let filled = 0
  while (filled < length) {
    const { bytesRead } = await handle.read(buf, filled, length - filled, position + filled)
    if (bytesRead === 0) return false
    filled += bytesRead
  }
  return true
}

type Child = { type: string; start: number; end: number }

/** Splits a buffer range into boxes, or null if any header is malformed or overruns `end`. */
function childBoxes(buf: Buffer, start: number, end: number): Child[] | null {
  const children: Child[] = []
  let offset = start
  while (offset + 8 <= end) {
    const size32 = buf.readUInt32BE(offset)
    const type = buf.toString('ascii', offset + 4, offset + 8)

    if (size32 === 0) {
      children.push({ type, start: offset + 8, end })
      return children
    }

    let size = size32
    let payloadStart = offset + 8
    if (size32 === 1) {
      if (offset + 16 > end) return null
      const size64 = buf.readBigUInt64BE(offset + 8)
      if (size64 < 16n || size64 > BigInt(end - offset)) return null
      size = Number(size64)
      payloadStart = offset + 16
    } else if (size32 < 8 || offset + size32 > end) {
      return null
    }

    children.push({ type, start: payloadStart, end: offset + size })
    offset += size
  }
  // Trailing bytes that are not a box mean the parse has lost its place.
  return offset === end ? children : null
}

function findChild(children: Child[], type: string): Child | null {
  return children.find((child) => child.type === type) ?? null
}

/** Reads a big-endian field of 0, 4 or 8 bytes, or null if 8 bytes exceed a safe integer. */
function readField(buf: Buffer, at: number, size: number): number | null {
  if (size === 0) return 0
  if (size !== 8) return buf.readUIntBE(at, size)
  const value = buf.readBigUInt64BE(at)
  return value > BigInt(Number.MAX_SAFE_INTEGER) ? null : Number(value)
}

function readPrimaryItemId(buf: Buffer, pitm: Child): number | null {
  const width = buf.readUInt8(pitm.start) === 0 ? 2 : 4
  if (pitm.start + 4 + width > pitm.end) return null
  return buf.readUIntBE(pitm.start + 4, width)
}

type ItemReferences = Map<string, Map<number, number[]>>

/** `iref` as reference kind -> from-item -> to-items. */
function readItemReferences(buf: Buffer, iref: Child): ItemReferences | null {
  const idWidth = buf.readUInt8(iref.start) === 0 ? 2 : 4
  const boxes = childBoxes(buf, iref.start + 4, iref.end)
  if (boxes === null) return null

  const refs: ItemReferences = new Map()
  for (const ref of boxes) {
    if (ref.start + idWidth + 2 > ref.end) return null
    const from = buf.readUIntBE(ref.start, idWidth)
    const count = buf.readUInt16BE(ref.start + idWidth)
    const listStart = ref.start + idWidth + 2
    if (listStart + count * idWidth > ref.end) return null

    const to: number[] = []
    for (let i = 0; i < count; i++) to.push(buf.readUIntBE(listStart + i * idWidth, idWidth))

    const byKind = refs.get(ref.type) ?? new Map<number, number[]>()
    byKind.set(from, [...(byKind.get(from) ?? []), ...to])
    refs.set(ref.type, byKind)
  }
  return refs
}

type Extent = { start: number; length: number }
type ItemLocation = { construction: number; extents: Extent[] }

/** `iloc`, whose every field width is declared in the box itself and varies by version. */
function readItemLocations(buf: Buffer, iloc: Child): Map<number, ItemLocation> | null {
  const version = buf.readUInt8(iloc.start)
  let at = iloc.start + 4
  if (at + 2 > iloc.end) return null

  const offsetSize = buf.readUInt8(at) >> 4
  const lengthSize = buf.readUInt8(at) & 0xf
  const baseOffsetSize = buf.readUInt8(at + 1) >> 4
  const indexSize = version === 1 || version === 2 ? buf.readUInt8(at + 1) & 0xf : 0
  at += 2
  for (const size of [offsetSize, lengthSize, baseOffsetSize, indexSize]) {
    if (size !== 0 && size !== 4 && size !== 8) return null
  }

  const idWidth = version < 2 ? 2 : 4
  if (at + idWidth > iloc.end) return null
  const count = buf.readUIntBE(at, idWidth)
  at += idWidth

  const locations = new Map<number, ItemLocation>()
  for (let i = 0; i < count; i++) {
    if (at + idWidth + 2 > iloc.end) return null
    const id = buf.readUIntBE(at, idWidth)
    at += idWidth

    let construction = 0
    if (version === 1 || version === 2) {
      construction = buf.readUInt16BE(at) & 0xf
      at += 2
      if (at + 2 > iloc.end) return null
    }

    // A non-zero data reference points into another file, whose bytes are not ours to hash.
    if (buf.readUInt16BE(at) !== 0) return null
    at += 2

    if (at + baseOffsetSize + 2 > iloc.end) return null
    const base = readField(buf, at, baseOffsetSize)
    if (base === null) return null
    at += baseOffsetSize
    const extentCount = buf.readUInt16BE(at)
    at += 2

    const extents: Extent[] = []
    for (let e = 0; e < extentCount; e++) {
      if (at + indexSize + offsetSize + lengthSize > iloc.end) return null
      at += indexSize
      const offset = readField(buf, at, offsetSize)
      at += offsetSize
      const length = readField(buf, at, lengthSize)
      at += lengthSize
      // A zero length means "to the end of the file", which nothing that reaches here writes.
      if (offset === null || length === null || length === 0) return null
      extents.push({ start: base + offset, length })
    }
    locations.set(id, { construction, extents })
  }
  return locations
}

/** Breadth-first over `dimg`, appending to `ordered`; false once the item bound is passed. */
function walkDerived(
  seeds: number[],
  derived: Map<number, number[]>,
  ordered: number[],
  seen: Set<number>,
): boolean {
  const queue = [...seeds]
  while (queue.length > 0) {
    const id = queue.shift() as number
    if (seen.has(id)) continue
    seen.add(id)
    ordered.push(id)
    if (ordered.length > MAX_ITEMS) return false
    queue.push(...(derived.get(id) ?? []))
  }
  return true
}

/**
 * The primary image, whatever it is assembled from, and any auxiliary image hung off it — an
 * alpha channel, a depth map, an HDR gain map. Exif and XMP are items too, but they hang off
 * the picture by `cdsc` rather than making it up, so they are exactly what this leaves out.
 *
 * Auxiliary items come last in item-id order rather than in `iref` order, so that a rewriter
 * that reorders the references cannot change the hash.
 */
function collectItemIds(primary: number, refs: ItemReferences): number[] | null {
  const derived = refs.get('dimg') ?? new Map<number, number[]>()
  const ordered: number[] = []
  const seen = new Set<number>()
  if (!walkDerived([primary], derived, ordered, seen)) return null

  const auxiliary = [...(refs.get('auxl') ?? new Map<number, number[]>())]
    .filter(([, to]) => to.some((id) => seen.has(id)))
    .map(([from]) => from)
    .sort((a, b) => a - b)

  return walkDerived(auxiliary, derived, ordered, seen) ? ordered : null
}

/** Hashes the image items' extents, or null if the `meta` box does not yield a clean walk. */
async function hashHeifItems(
  handle: FileHandle,
  fileSize: number,
  meta: BoxHeader,
): Promise<string | null> {
  const metaLength = meta.payloadEnd - meta.payloadStart
  if (metaLength < 4 || metaLength > MAX_META_BYTES) return null
  const buf = Buffer.alloc(metaLength)
  if (!(await readExact(handle, buf, metaLength, meta.payloadStart))) return null

  // `meta` is a FullBox, so its children start after the version and flags.
  const children = childBoxes(buf, 4, metaLength)
  if (children === null) return null

  const pitm = findChild(children, 'pitm')
  const iloc = findChild(children, 'iloc')
  if (pitm === null || iloc === null) return null
  const primary = readPrimaryItemId(buf, pitm)
  const locations = readItemLocations(buf, iloc)
  if (primary === null || locations === null) return null

  const iref = findChild(children, 'iref')
  const refs = iref === null ? (new Map() as ItemReferences) : readItemReferences(buf, iref)
  if (refs === null) return null

  const ids = collectItemIds(primary, refs)
  if (ids === null) return null

  const idat = findChild(children, 'idat')
  const hash = createHash('sha256')
  let hashed = 0

  for (const id of ids) {
    const location = locations.get(id)
    if (location === undefined) return null
    for (const extent of location.extents) {
      hashed += extent.length
      // Extents partition the file's item data, so a total past the file size is a crafted
      // set of items aimed at the same bytes over and over.
      if (hashed > fileSize) return null

      if (location.construction === 0) {
        if (extent.start + extent.length > fileSize) return null
        await streamRangeInto(handle, hash, extent.start, extent.start + extent.length)
        continue
      }

      // Method 1 reads out of `idat`. Method 2 reads out of another item: nothing in the wild
      // writes it, and a wrong guess would mis-hash silently rather than fail.
      if (location.construction !== 1 || idat === null) return null
      const from = idat.start + extent.start
      if (from + extent.length > idat.end) return null
      hash.update(buf.subarray(from, from + extent.length))
    }
  }
  return hash.digest('hex')
}

/** The `ftyp` major brand followed by the compatible brands. */
async function readBrands(handle: FileHandle, ftyp: BoxHeader): Promise<string[]> {
  const length = Math.min(ftyp.payloadEnd - ftyp.payloadStart, MAX_FTYP_BYTES)
  if (length < 4) return []
  const buf = Buffer.alloc(length)
  if (!(await readExact(handle, buf, length, ftyp.payloadStart))) return []

  const brands = [buf.toString('ascii', 0, 4)]
  for (let at = 8; at + 4 <= length; at += 4) brands.push(buf.toString('ascii', at, at + 4))
  return brands
}

type Layout = { brands: string[]; meta: BoxHeader | null; mdats: BoxHeader[]; hasTracks: boolean }

/** Walks the top-level boxes once, recording only what the two hashing rules need. */
async function readLayout(handle: FileHandle, fileSize: number): Promise<Layout | null> {
  const headerBuf = Buffer.alloc(16)
  const mdats: BoxHeader[] = []
  let brands: string[] = []
  let meta: BoxHeader | null = null
  let hasTracks = false
  let offset = 0
  let boxCount = 0

  while (offset < fileSize) {
    if (boxCount++ >= MAX_BOXES) return null
    const want = Math.min(16, fileSize - offset)
    if (want < 8) return null
    if (!(await readExact(handle, headerBuf, want, offset))) return null
    const box = readBoxHeader(headerBuf.subarray(0, want), offset, fileSize)
    if (box === null) return null

    if (box.type === 'mdat') mdats.push(box)
    if (box.type === 'moov') hasTracks = true
    if (box.type === 'meta' && meta === null) meta = box
    if (box.type === 'ftyp' && brands.length === 0) brands = await readBrands(handle, box)
    offset = box.payloadEnd
  }
  return { brands, meta, mdats, hasTracks }
}

/**
 * For a HEIF, the extents of the picture's own items; for everything else the concatenated
 * payload of every top-level `mdat` box, in file order.
 */
async function hashIsoBmff(path: string, fileSize: number): Promise<string | null> {
  const handle = await open(path, 'r')
  try {
    const layout = await readLayout(handle, fileSize)
    if (layout === null) return null

    // `msf1` and `avis` also brand image *sequences*, whose frames are tracks: those carry a
    // `meta` with a cover item, and hashing it alone would call two animations the same file.
    if (
      layout.meta !== null &&
      !layout.hasTracks &&
      layout.brands.some((brand) => HEIF_BRANDS.has(brand))
    ) {
      // A HEIF's picture is its items, and there is no second rule to fall back on: two rules
      // for one file would mean one photograph hashing two ways depending on what parsed.
      // Awaited, not returned bare: the `finally` below would otherwise close the handle
      // out from under the walk.
      return await hashHeifItems(handle, fileSize, layout.meta)
    }

    if (layout.mdats.length === 0) return null
    const hash = createHash('sha256')
    for (const mdat of layout.mdats) {
      await streamRangeInto(handle, hash, mdat.payloadStart, mdat.payloadEnd)
    }
    return hash.digest('hex')
  } catch {
    return null
  } finally {
    await handle.close()
  }
}

export async function contentHash(absolutePath: string): Promise<string | null> {
  let size: number
  try {
    size = (await stat(absolutePath)).size
  } catch {
    return null
  }
  if (size < 4) return null

  const headBuf = Buffer.alloc(8)
  try {
    const handle = await open(absolutePath, 'r')
    try {
      await handle.read(headBuf, 0, Math.min(8, size), 0)
    } finally {
      await handle.close()
    }
  } catch {
    return null
  }

  if (headBuf[0] === 0xff && headBuf[1] === SOI) {
    if (size > MAX_JPEG_BYTES) return null
    let bytes: Uint8Array
    try {
      bytes = new Uint8Array(await Bun.file(absolutePath).arrayBuffer())
    } catch {
      return null
    }
    return hashJpeg(bytes)
  }

  if (headBuf.subarray(4, 8).toString('ascii') === 'ftyp') {
    return hashIsoBmff(absolutePath, size)
  }

  return null
}
