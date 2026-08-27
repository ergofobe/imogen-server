import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { sql } from 'drizzle-orm'
import sharp from 'sharp'
import { createApp } from '../app.ts'
import { createServices } from '../services.ts'
import { createTestConfig, createTestDatabase, removeTestConfig } from '../test/harness.ts'

process.env.NODE_ENV = 'test'

const harness = await createTestDatabase()
const config = createTestConfig({ publicUrl: 'http://localhost:3000' })
const services = createServices(config, harness.db)
const app = createApp({ services })

afterAll(async () => {
  await harness.close()
  removeTestConfig(config)
})

beforeEach(async () => {
  await harness.db.execute(
    sql`truncate users, assets, albums, oauth_clients, oauth_tokens, oauth_auth_codes, jobs, sessions cascade`,
  )
})

const request = (path: string, init: RequestInit = {}) =>
  app.fetch(new Request(`http://localhost:3000${path}`, init))

const json = (path: string, method: string, body: unknown, cookie?: string) =>
  request(path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
    body: JSON.stringify(body),
  })

async function photo(name: string) {
  const seed = [...name].reduce((a, c) => (a * 31 + c.charCodeAt(0)) % 251, 7)
  const buffer = await sharp({
    create: { width: 400, height: 300, channels: 3, background: { r: seed, g: 80, b: 160 } },
  })
    .jpeg()
    .toBuffer()
  return new File([new Uint8Array(buffer)], name, { type: 'image/jpeg' })
}

/** Signs up, uploads two photos, and hides one of them in the vault. */
async function setup() {
  const signup = await json('/api/v1/auth/signup', 'POST', {
    email: 'owner@example.com',
    password: 'a-sufficiently-long-password',
    name: 'Owner',
  })
  const cookie = signup.headers.get('set-cookie')?.split(';')[0] ?? ''

  const upload = async (name: string) => {
    const form = new FormData()
    form.set('file', await photo(name))
    const response = await request('/api/v1/assets', {
      method: 'POST',
      headers: { Cookie: cookie },
      body: form,
    })
    return ((await response.json()) as { asset: { id: string } }).asset.id
  }

  const secretId = await upload('private-moment.jpg')
  const publicId = await upload('holiday.jpg')
  await services.queue.drain()

  await json('/api/v1/vault/setup', 'POST', { passphrase: 'a-strong-vault-passphrase' }, cookie)
  const unlockResponse = await json(
    '/api/v1/vault/unlock',
    'POST',
    { passphrase: 'a-strong-vault-passphrase' },
    cookie,
  )
  const unlockCookie = unlockResponse.headers.get('set-cookie')?.split(';')[0] ?? ''
  const bothCookies = `${cookie}; ${unlockCookie}`

  await json('/api/v1/vault/assets', 'POST', { assetIds: [secretId] }, bothCookies)

  return { cookie, unlockCookie, bothCookies, secretId, publicId }
}

describe('a vaulted photo is absent from the ordinary library', () => {
  test('it is not in the timeline listing', async () => {
    const { cookie, secretId, publicId } = await setup()

    const page = (await (
      await request('/api/v1/assets', { headers: { Cookie: cookie } })
    ).json()) as {
      items: Array<{ id: string }>
    }

    expect(page.items.map((i) => i.id)).toEqual([publicId])
    expect(page.items.map((i) => i.id)).not.toContain(secretId)
  })

  test('it cannot be found by searching for its filename', async () => {
    const { cookie } = await setup()

    const page = (await (
      await request('/api/v1/assets?q=private', { headers: { Cookie: cookie } })
    ).json()) as { items: unknown[] }

    expect(page.items).toBeEmpty()
  })

  test('it is absent from the day buckets', async () => {
    const { cookie } = await setup()

    const body = (await (
      await request('/api/v1/assets/timeline', { headers: { Cookie: cookie } })
    ).json()) as { buckets: Array<{ count: number }> }

    expect(body.buckets.reduce((sum, b) => sum + b.count, 0)).toBe(1)
  })

  test('it is absent from a period bucket, whose tiles serialise what the route promises', async () => {
    const { cookie, secretId, publicId } = await setup()
    // Uploaded fixtures carry no EXIF capture time, so they land in the current month.
    const period = new Date().toISOString().slice(0, 7)

    const body = (await (
      await request(`/api/v1/assets/timeline/bucket?period=${period}&limit=10`, {
        headers: { Cookie: cookie },
      })
    ).json()) as {
      items: Array<{
        id: string
        capturedAt: string
        type: string
        status: string
        width: number | null
        height: number | null
        favorite: boolean
        duration: number | null
        placeholderColor: string | null
        livePhotoVideoId: string | null
      }>
      nextCursor: string | null
      total: number | null
    }

    // Pins that /timeline/bucket is reachable ahead of /:id — an id-shaped route
    // registered first would otherwise swallow this path — and that the handler's
    // inferred return type matches the declared pageOf(TimelineTile) response, which
    // @hono/zod-openapi does not check at runtime.
    expect(body.items.map((i) => i.id)).toEqual([publicId])
    expect(body.items.map((i) => i.id)).not.toContain(secretId)
    expect(body.total).toBe(1)
    expect(body.nextCursor).toBeNull()
    const tile = body.items[0]!
    expect(tile.type).toBe('image')
    expect(typeof tile.capturedAt).toBe('string')
    expect('width' in tile).toBe(true)
    expect('livePhotoVideoId' in tile).toBe(true)
  })

  test('it is not counted in library statistics', async () => {
    const { cookie } = await setup()

    const stats = (await (
      await request('/api/v1/assets/stats', { headers: { Cookie: cookie } })
    ).json()) as { assetCount: number; vaultedCount: number }

    expect(stats.assetCount).toBe(1)
  })

  test('fetching it by id is refused without the vault unlocked', async () => {
    const { cookie, secretId } = await setup()

    const response = await request(`/api/v1/assets/${secretId}`, { headers: { Cookie: cookie } })

    expect(response.status).toBe(403)
  })

  test('its image bytes are refused without the vault unlocked', async () => {
    const { cookie, secretId } = await setup()

    const response = await request(`/api/v1/assets/${secretId}/thumbnail`, {
      headers: { Cookie: cookie },
    })

    expect(response.status).toBe(403)
  })

  test('its original is refused without the vault unlocked', async () => {
    const { cookie, secretId } = await setup()

    const response = await request(`/api/v1/assets/${secretId}/download`, {
      headers: { Cookie: cookie },
    })

    expect(response.status).toBe(403)
  })

  test('with the vault unlocked, it can be seen again', async () => {
    const { bothCookies, secretId } = await setup()

    const asset = await request(`/api/v1/assets/${secretId}`, { headers: { Cookie: bothCookies } })
    const thumbnail = await request(`/api/v1/assets/${secretId}/thumbnail`, {
      headers: { Cookie: bothCookies },
    })

    expect(asset.status).toBe(200)
    expect(thumbnail.status).toBe(200)
  })
})

describe('a vaulted photo is out of reach of albums and shares', () => {
  test('moving it into the vault removes it from its albums', async () => {
    const signup = await json('/api/v1/auth/signup', 'POST', {
      email: 'a@example.com',
      password: 'a-sufficiently-long-password',
      name: 'A',
    })
    const cookie = signup.headers.get('set-cookie')?.split(';')[0] ?? ''

    const form = new FormData()
    form.set('file', await photo('in-album.jpg'))
    const uploaded = (await (
      await request('/api/v1/assets', { method: 'POST', headers: { Cookie: cookie }, body: form })
    ).json()) as { asset: { id: string } }
    await services.queue.drain()

    const album = (await (
      await json('/api/v1/albums', 'POST', { name: 'Trip', assetIds: [uploaded.asset.id] }, cookie)
    ).json()) as { id: string }

    await json('/api/v1/vault/setup', 'POST', { passphrase: 'a-strong-vault-passphrase' }, cookie)
    const unlock = await json(
      '/api/v1/vault/unlock',
      'POST',
      { passphrase: 'a-strong-vault-passphrase' },
      cookie,
    )
    const both = `${cookie}; ${unlock.headers.get('set-cookie')?.split(';')[0] ?? ''}`
    await json('/api/v1/vault/assets', 'POST', { assetIds: [uploaded.asset.id] }, both)

    const after = (await (
      await request(`/api/v1/albums/${album.id}`, { headers: { Cookie: cookie } })
    ).json()) as { assets: unknown[] }

    expect(after.assets).toBeEmpty()
  })
})

describe('an AI assistant can never reach the vault', () => {
  async function connectorToken(cookie: string) {
    const client = (await (
      await json('/oauth/register', 'POST', {
        client_name: 'Claude',
        redirect_uris: ['https://claude.ai/api/mcp/auth_callback'],
        token_endpoint_auth_method: 'none',
      })
    ).json()) as { client_id: string }

    const { createHash, randomBytes } = await import('node:crypto')
    const verifier = randomBytes(32).toString('base64url')
    const challenge = createHash('sha256').update(verifier).digest('base64url')
    const params = new URLSearchParams({
      response_type: 'code',
      client_id: client.client_id,
      redirect_uri: 'https://claude.ai/api/mcp/auth_callback',
      code_challenge: challenge,
      code_challenge_method: 'S256',
      scope: 'library:read library:write albums:read albums:write',
      approved: 'yes',
    })
    const approved = await request(`/oauth/authorize?${params}`, {
      headers: { Cookie: cookie },
      redirect: 'manual',
    })
    const code = new URL(approved.headers.get('location')!).searchParams.get('code')!
    const token = (await (
      await request('/oauth/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          client_id: client.client_id,
          code,
          code_verifier: verifier,
          redirect_uri: 'https://claude.ai/api/mcp/auth_callback',
        }),
      })
    ).json()) as { access_token: string }
    return token.access_token
  }

  const rpc = (body: unknown, token: string) =>
    request('/mcp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    })

  test('search_photos never returns a vaulted photo', async () => {
    const { cookie } = await setup()
    const token = await connectorToken(cookie)

    const response = await rpc(
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'search_photos', arguments: {} },
      },
      token,
    )
    const body = (await response.json()) as { result: { content: Array<{ text: string }> } }

    expect(body.result.content[0]!.text).not.toContain('private-moment')
    expect(body.result.content[0]!.text).toContain('holiday')
  })

  test('get_photo refuses a vaulted photo even given its id', async () => {
    const { cookie, secretId } = await setup()
    const token = await connectorToken(cookie)

    const response = await rpc(
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'get_photo', arguments: { photoId: secretId } },
      },
      token,
    )
    const body = (await response.json()) as { result: { isError?: boolean } }

    expect(body.result.isError).toBe(true)
  })

  test('library statistics shown to an assistant exclude the vault', async () => {
    const { cookie } = await setup()
    const token = await connectorToken(cookie)

    const response = await rpc(
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'get_library_stats', arguments: {} },
      },
      token,
    )
    const body = (await response.json()) as { result: { content: Array<{ text: string }> } }

    expect(JSON.parse(body.result.content[0]!.text).photos).toBe(1)
  })

  /** An API token is not a person, so it can never satisfy a re-authentication. */
  test('an OAuth token cannot unlock the vault', async () => {
    const { cookie } = await setup()
    const token = await connectorToken(cookie)

    const response = await request('/api/v1/vault/unlock', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ passphrase: 'a-strong-vault-passphrase' }),
    })

    expect(response.status).toBe(403)
  })

  test('an OAuth token cannot list the vault', async () => {
    const { cookie } = await setup()
    const token = await connectorToken(cookie)

    const response = await request('/api/v1/vault/assets', {
      headers: { Authorization: `Bearer ${token}` },
    })

    expect(response.status).toBe(403)
  })
})

describe('locking', () => {
  test('locking the vault immediately hides it again', async () => {
    const { cookie, bothCookies, secretId } = await setup()

    expect(
      (await request(`/api/v1/assets/${secretId}`, { headers: { Cookie: bothCookies } })).status,
    ).toBe(200)

    await request('/api/v1/vault/lock', { method: 'POST', headers: { Cookie: bothCookies } })

    // The unlock cookie is cleared, so the browser goes back to sending only the session.
    const after = await request(`/api/v1/assets/${secretId}`, { headers: { Cookie: cookie } })
    expect(after.status).toBe(403)
  })

  test('reports vault status without revealing its contents', async () => {
    const { cookie } = await setup()

    const status = (await (
      await request('/api/v1/vault/status', { headers: { Cookie: cookie } })
    ).json()) as { configured: boolean; unlocked: boolean; count?: number }

    expect(status.configured).toBe(true)
    expect(status.unlocked).toBe(false)
    expect(status.count).toBeUndefined()
  })
})
