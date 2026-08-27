import { describe, expect, test } from 'bun:test'
import { decodeWithFfmpeg } from './decode.ts'

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
