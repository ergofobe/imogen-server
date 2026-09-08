import { createHash, type Hash } from 'node:crypto'
import { type FileHandle, open, stat } from 'node:fs/promises'

const MAX_JPEG_BYTES = 256 * 1024 * 1024
const MDAT_CHUNK_BYTES = 1024 * 1024
// A long fragmented recording is a few thousand moof/mdat pairs; this is generous headroom
// against a crafted file of millions of 8-byte boxes that would otherwise pin the request.
const MAX_BOXES = 65536

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

async function streamMdatInto(
  handle: FileHandle,
  hash: Hash,
  start: number,
  end: number,
): Promise<void> {
  const buffer = Buffer.alloc(MDAT_CHUNK_BYTES)
  let position = start
  while (position < end) {
    const toRead = Math.min(MDAT_CHUNK_BYTES, end - position)
    const { bytesRead } = await handle.read(buffer, 0, toRead, position)
    if (bytesRead === 0) throw new Error('unexpected end of file while streaming mdat')
    hash.update(buffer.subarray(0, bytesRead))
    position += bytesRead
  }
}

/** Hashes the concatenated payload of every top-level `mdat` box, in file order. */
async function hashIsoBmff(path: string, fileSize: number): Promise<string | null> {
  const handle = await open(path, 'r')
  try {
    const headerBuf = Buffer.alloc(16)
    const hash = createHash('sha256')
    let offset = 0
    let sawMdat = false
    let boxCount = 0

    while (offset < fileSize) {
      if (boxCount++ >= MAX_BOXES) return null
      const { bytesRead } = await handle.read(headerBuf, 0, Math.min(16, fileSize - offset), offset)
      if (bytesRead < 8) return null
      const box = readBoxHeader(headerBuf.subarray(0, bytesRead), offset, fileSize)
      if (box === null) return null

      if (box.type === 'mdat') {
        sawMdat = true
        await streamMdatInto(handle, hash, box.payloadStart, box.payloadEnd)
      }
      offset = box.payloadEnd
    }

    return sawMdat ? hash.digest('hex') : null
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
