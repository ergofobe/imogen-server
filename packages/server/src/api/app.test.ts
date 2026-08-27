import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { createHash, randomBytes } from 'node:crypto'
import { sql } from 'drizzle-orm'
import sharp from 'sharp'
import { createApp } from '../app.ts'
import { createServices } from '../services.ts'
import { createTestConfig, createTestDatabase, removeTestConfig } from '../test/harness.ts'

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

const jsonRequest = (path: string, method: string, body: unknown, cookie?: string) =>
  request(path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(cookie ? { Cookie: cookie } : {}),
    },
    body: JSON.stringify(body),
  })

async function signUp(email = 'owner@example.com') {
  const response = await jsonRequest('/api/v1/auth/signup', 'POST', {
    email,
    password: 'a-sufficiently-long-password',
    name: 'Owner',
  })
  const cookie = response.headers.get('set-cookie')?.split(';')[0] ?? ''
  return { response, cookie, user: (await response.json()) as { id: string; role: string } }
}

/**
 * Distinct pixels per filename. Two photos with identical bytes are deliberately
 * deduplicated into one asset, so fixtures that differ only by name would silently
 * test the wrong thing.
 */
async function makePhoto(name = 'photo.jpg') {
  const seed = [...name].reduce((acc, ch) => (acc * 31 + ch.charCodeAt(0)) % 251, 7)
  const buffer = await sharp({
    create: {
      width: 800,
      height: 600,
      channels: 3,
      background: { r: seed, g: (seed * 3) % 256, b: (seed * 7) % 256 },
    },
  })
    .jpeg()
    .toBuffer()
  return new File([new Uint8Array(buffer)], name, { type: 'image/jpeg' })
}

async function upload(cookie: string, file: File) {
  const form = new FormData()
  form.set('file', file)
  return request('/api/v1/assets', { method: 'POST', headers: { Cookie: cookie }, body: form })
}

describe('health and docs', () => {
  test('health check answers without authentication', async () => {
    const response = await request('/api/v1/health')

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ status: 'ok' })
  })

  test('publishes an OpenAPI document describing the API', async () => {
    const response = await request('/api/v1/openapi.json')
    const doc = (await response.json()) as {
      openapi: string
      paths: Record<string, unknown>
      components: { securitySchemes: Record<string, unknown> }
    }

    expect(response.status).toBe(200)
    expect(doc.openapi).toStartWith('3.1')
    expect(Object.keys(doc.paths)).toContain('/api/v1/assets')
    expect(Object.keys(doc.components.securitySchemes)).toContain('oauth2')
  })
})

describe('account lifecycle', () => {
  test('the first signup becomes an administrator and receives a session', async () => {
    const { response, cookie, user } = await signUp()

    expect(response.status).toBe(200)
    expect(user.role).toBe('admin')
    expect(cookie).toStartWith('imogen_session=')
  })

  test('the session cookie is HttpOnly so scripts cannot read it', async () => {
    const { response } = await signUp()

    expect(response.headers.get('set-cookie')?.toLowerCase()).toContain('httponly')
  })

  test('rejects an unauthenticated request for the library', async () => {
    const response = await request('/api/v1/assets')

    expect(response.status).toBe(401)
  })

  test('a 401 points the caller at the OAuth metadata document', async () => {
    const response = await request('/api/v1/assets')

    expect(response.headers.get('www-authenticate')).toContain('resource_metadata=')
  })

  test('signing out invalidates the session', async () => {
    const { cookie } = await signUp()

    await request('/api/v1/auth/logout', { method: 'POST', headers: { Cookie: cookie } })

    const after = await request('/api/v1/assets', { headers: { Cookie: cookie } })
    expect(after.status).toBe(401)
  })

  test('a wrong password gives the same answer as an unknown address', async () => {
    await signUp()

    const wrongPassword = await jsonRequest('/api/v1/auth/login', 'POST', {
      email: 'owner@example.com',
      password: 'not-the-right-password',
    })
    const unknownUser = await jsonRequest('/api/v1/auth/login', 'POST', {
      email: 'nobody@example.com',
      password: 'not-the-right-password',
    })

    expect(wrongPassword.status).toBe(401)
    expect(unknownUser.status).toBe(401)
    expect(await wrongPassword.json()).toEqual(await unknownUser.json())
  })

  test('validation failures come back in the documented envelope', async () => {
    const response = await jsonRequest('/api/v1/auth/signup', 'POST', {
      email: 'not-an-email',
      password: 'short',
      name: '',
    })
    const body = (await response.json()) as { error: { code: string; details: object } }

    expect(response.status).toBe(400)
    expect(body.error.code).toBe('validation_failed')
    expect(Object.keys(body.error.details)).toContain('email')
  })
})

describe('uploading', () => {
  test('accepts a photo and reports it as pending', async () => {
    const { cookie } = await signUp()

    const response = await upload(cookie, await makePhoto())
    const body = (await response.json()) as { asset: { status: string }; duplicate: boolean }

    expect(response.status).toBe(201)
    expect(body.duplicate).toBe(false)
    expect(body.asset.status).toBe('pending')
  })

  test('processing produces a thumbnail that can be fetched', async () => {
    const { cookie } = await signUp()
    const uploaded = (await (await upload(cookie, await makePhoto())).json()) as {
      asset: { id: string }
    }

    await services.queue.drain()

    const asset = await request(`/api/v1/assets/${uploaded.asset.id}`, {
      headers: { Cookie: cookie },
    })
    expect(((await asset.json()) as { status: string }).status).toBe('ready')

    const thumbnail = await request(`/api/v1/assets/${uploaded.asset.id}/thumbnail`, {
      headers: { Cookie: cookie },
    })
    expect(thumbnail.status).toBe(200)
    expect(thumbnail.headers.get('content-type')).toBe('image/webp')
  })

  test('re-uploading the same bytes returns the original rather than a copy', async () => {
    const { cookie } = await signUp()
    const photo = await makePhoto()
    const first = (await (await upload(cookie, photo)).json()) as { asset: { id: string } }

    const response = await upload(cookie, photo)
    const second = (await response.json()) as { asset: { id: string }; duplicate: boolean }

    expect(response.status).toBe(200)
    expect(second.duplicate).toBe(true)
    expect(second.asset.id).toBe(first.asset.id)
  })

  test('refuses a file that is neither a photo nor a video', async () => {
    const { cookie } = await signUp()
    const form = new FormData()
    form.set('file', new File(['not a photo'], 'contract.pdf', { type: 'application/pdf' }))

    const response = await request('/api/v1/assets', {
      method: 'POST',
      headers: { Cookie: cookie },
      body: form,
    })

    expect(response.status).toBe(415)
  })

  test('one user cannot read another user’s photo', async () => {
    const owner = await signUp('owner@example.com')
    const intruder = await signUp('intruder@example.com')
    const uploaded = (await (await upload(owner.cookie, await makePhoto())).json()) as {
      asset: { id: string }
    }

    const response = await request(`/api/v1/assets/${uploaded.asset.id}`, {
      headers: { Cookie: intruder.cookie },
    })

    expect(response.status).toBe(403)
  })
})

describe('albums and sharing', () => {
  async function setup() {
    const { cookie } = await signUp()
    const uploaded = (await (await upload(cookie, await makePhoto())).json()) as {
      asset: { id: string }
    }
    await services.queue.drain()
    const album = (await (
      await jsonRequest('/api/v1/albums', 'POST', { name: 'Holiday' }, cookie)
    ).json()) as { id: string }
    await jsonRequest(
      `/api/v1/albums/${album.id}/assets`,
      'POST',
      { assetIds: [uploaded.asset.id] },
      cookie,
    )
    return { cookie, albumId: album.id, assetId: uploaded.asset.id }
  }

  test('creates an album and adds a photo to it', async () => {
    const { cookie, albumId } = await setup()

    const response = await request(`/api/v1/albums/${albumId}`, { headers: { Cookie: cookie } })
    const album = (await response.json()) as { name: string; assets: unknown[] }

    expect(album.name).toBe('Holiday')
    expect(album.assets).toHaveLength(1)
  })

  test('adding the same photo twice is counted as skipped', async () => {
    const { cookie, albumId, assetId } = await setup()

    const response = await jsonRequest(
      `/api/v1/albums/${albumId}/assets`,
      'POST',
      { assetIds: [assetId] },
      cookie,
    )

    expect(await response.json()).toMatchObject({ added: 0, skipped: 1, assetCount: 1 })
  })

  test('an album is ordered newest first, whatever order things were added in', async () => {
    const { cookie, albumId } = await setup()

    const madeOn = async (name: string, capturedAt: string) => {
      const uploaded = (await (await upload(cookie, await makePhoto(name))).json()) as {
        asset: { id: string }
      }
      await harness.db.execute(
        sql`update assets set captured_at = ${capturedAt} where id = ${uploaded.asset.id}`,
      )
      return uploaded.asset.id
    }

    const middle = await madeOn('middle.jpg', '2021-06-01T12:00:00Z')
    const oldest = await madeOn('oldest.jpg', '2019-01-01T12:00:00Z')
    const newest = await madeOn('newest.jpg', '2024-12-25T12:00:00Z')

    // Added deliberately out of order, which is what the timeline would never do.
    await jsonRequest(
      `/api/v1/albums/${albumId}/assets`,
      'POST',
      { assetIds: [middle, oldest, newest] },
      cookie,
    )

    const response = await request(`/api/v1/albums/${albumId}`, { headers: { Cookie: cookie } })
    const body = (await response.json()) as { assets: Array<{ id: string; capturedAt: string }> }
    const added = body.assets.filter((a) => [middle, oldest, newest].includes(a.id))

    expect(added.map((a) => a.id)).toEqual([newest, middle, oldest])
  })

  test('an album shows a cover as soon as it holds a photograph', async () => {
    const { cookie, albumId, assetId } = await setup()
    await jsonRequest(`/api/v1/albums/${albumId}/assets`, 'POST', { assetIds: [assetId] }, cookie)

    const listed = await request('/api/v1/albums', { headers: { Cookie: cookie } })
    const { items } = (await listed.json()) as { items: Array<{ coverAssetId: string | null }> }

    expect(items[0]?.coverAssetId).toBe(assetId)
  })

  test('a chosen cover is not overruled by the first photograph', async () => {
    const { cookie, albumId, assetId } = await setup()
    const second = (await (await upload(cookie, await makePhoto('second.jpg'))).json()) as {
      asset: { id: string }
    }
    await jsonRequest(
      `/api/v1/albums/${albumId}/assets`,
      'POST',
      { assetIds: [assetId, second.asset.id] },
      cookie,
    )

    await jsonRequest(
      `/api/v1/albums/${albumId}`,
      'PATCH',
      { coverAssetId: second.asset.id },
      cookie,
    )

    const listed = await request('/api/v1/albums', { headers: { Cookie: cookie } })
    const { items } = (await listed.json()) as { items: Array<{ coverAssetId: string | null }> }
    expect(items[0]?.coverAssetId).toBe(second.asset.id)
  })

  test('a vaulted photograph is never the face of an album', async () => {
    const { cookie, albumId, assetId } = await setup()
    await jsonRequest(`/api/v1/albums/${albumId}/assets`, 'POST', { assetIds: [assetId] }, cookie)
    // Vaulted directly: what is under test is the cover query, not the route that
    // sets the column, and driving the vault over HTTP drags its cookie in with it.
    await harness.db.execute(sql`update assets set vaulted_at = now() where id = ${assetId}`)

    const listed = await request('/api/v1/albums', { headers: { Cookie: cookie } })
    const { items } = (await listed.json()) as { items: Array<{ coverAssetId: string | null }> }

    // The whole point of the vault is that these do not turn up anywhere else.
    expect(items[0]?.coverAssetId).toBeNull()
  })

  test('a share link lets an anonymous visitor see the album', async () => {
    const { cookie, albumId } = await setup()
    const link = (await (
      await jsonRequest(`/api/v1/albums/${albumId}/share`, 'POST', { allowDownload: true }, cookie)
    ).json()) as { slug: string }

    const response = await request(`/api/v1/share/${link.slug}`)
    const body = (await response.json()) as { album: { assets: unknown[] } }

    expect(response.status).toBe(200)
    expect(body.album.assets).toHaveLength(1)
  })

  test('a revoked share link stops working', async () => {
    const { cookie, albumId } = await setup()
    const link = (await (
      await jsonRequest(`/api/v1/albums/${albumId}/share`, 'POST', { allowDownload: true }, cookie)
    ).json()) as { slug: string }

    await request(`/api/v1/albums/${albumId}/share`, {
      method: 'DELETE',
      headers: { Cookie: cookie },
    })

    expect((await request(`/api/v1/share/${link.slug}`)).status).toBe(404)
  })

  test('a password-protected share stays locked without the password', async () => {
    const { cookie, albumId } = await setup()
    const link = (await (
      await jsonRequest(
        `/api/v1/albums/${albumId}/share`,
        'POST',
        { allowDownload: true, password: 'open-sesame' },
        cookie,
      )
    ).json()) as { slug: string }

    const locked = await request(`/api/v1/share/${link.slug}`)
    expect(locked.status).toBe(401)

    // The password is posted, never put in a URL, and the proof comes back as a cookie.
    const unlock = await jsonRequest(`/api/v1/share/${link.slug}/unlock`, 'POST', {
      password: 'open-sesame',
    })
    expect(unlock.status).toBe(200)

    const unlockCookie = unlock.headers.get('set-cookie')?.split(';')[0] ?? ''
    const unlocked = await request(`/api/v1/share/${link.slug}`, {
      headers: { Cookie: unlockCookie },
    })
    expect(unlocked.status).toBe(200)
  })

  test('rejects a wrong password and issues no unlock cookie', async () => {
    const { cookie, albumId } = await setup()
    const link = (await (
      await jsonRequest(
        `/api/v1/albums/${albumId}/share`,
        'POST',
        { allowDownload: true, password: 'open-sesame' },
        cookie,
      )
    ).json()) as { slug: string }

    const response = await jsonRequest(`/api/v1/share/${link.slug}/unlock`, 'POST', {
      password: 'wrong',
    })

    expect(response.status).toBe(401)
    expect(response.headers.get('set-cookie')).toBeNull()
  })

  test('a forged unlock cookie does not open a locked album', async () => {
    const { cookie, albumId } = await setup()
    const link = (await (
      await jsonRequest(
        `/api/v1/albums/${albumId}/share`,
        'POST',
        { allowDownload: true, password: 'open-sesame' },
        cookie,
      )
    ).json()) as { slug: string }

    const forged = `imogen_share_${link.slug}=${Date.now() + 60000}.not-a-real-signature`
    const response = await request(`/api/v1/share/${link.slug}`, { headers: { Cookie: forged } })

    expect(response.status).toBe(401)
  })

  test('a share link never carries the password in its URL', async () => {
    const { cookie, albumId } = await setup()
    const link = (await (
      await jsonRequest(
        `/api/v1/albums/${albumId}/share`,
        'POST',
        { allowDownload: true, password: 'open-sesame' },
        cookie,
      )
    ).json()) as { url: string }

    expect(link.url).not.toContain('open-sesame')
    expect(link.url).not.toContain('password')
  })

  test('a share slug does not grant access to photos outside its album', async () => {
    const { cookie, albumId } = await setup()
    const other = (await (await upload(cookie, await makePhoto('other.jpg'))).json()) as {
      asset: { id: string }
    }
    await services.queue.drain()
    const link = (await (
      await jsonRequest(`/api/v1/albums/${albumId}/share`, 'POST', { allowDownload: true }, cookie)
    ).json()) as { slug: string }

    const response = await request(`/api/v1/share/${link.slug}/assets/${other.asset.id}/preview`)

    expect(response.status).toBe(404)
  })
})

describe('OAuth discovery and flow', () => {
  test('advertises the authorization server', async () => {
    const response = await request('/.well-known/oauth-authorization-server')
    const meta = (await response.json()) as Record<string, unknown>

    expect(response.status).toBe(200)
    expect(meta.registration_endpoint).toBe('http://localhost:3000/oauth/register')
    expect(meta.code_challenge_methods_supported).toEqual(['S256'])
  })

  test('advertises the protected resource for MCP clients', async () => {
    const response = await request('/.well-known/oauth-protected-resource/mcp')

    expect(response.status).toBe(200)
    expect((await response.json()) as { resource: string }).toMatchObject({
      resource: 'http://localhost:3000',
    })
  })

  test('a client can register itself', async () => {
    const response = await jsonRequest('/oauth/register', 'POST', {
      client_name: 'Test Connector',
      redirect_uris: ['https://claude.ai/api/mcp/auth_callback'],
      token_endpoint_auth_method: 'none',
    })
    const client = (await response.json()) as { client_id: string }

    expect(response.status).toBe(201)
    expect(client.client_id).toBeString()
  })

  /** The whole connector journey: register, consent, exchange, then call the API. */
  test('completes an end-to-end authorization code flow with PKCE', async () => {
    const { cookie } = await signUp()
    const uploaded = (await (await upload(cookie, await makePhoto())).json()) as {
      asset: { id: string }
    }
    await services.queue.drain()

    const client = (await (
      await jsonRequest('/oauth/register', 'POST', {
        client_name: 'Test Connector',
        redirect_uris: ['https://claude.ai/api/mcp/auth_callback'],
        token_endpoint_auth_method: 'none',
      })
    ).json()) as { client_id: string }

    const verifier = randomBytes(32).toString('base64url')
    const challenge = createHash('sha256').update(verifier).digest('base64url')
    const params = new URLSearchParams({
      response_type: 'code',
      client_id: client.client_id,
      redirect_uri: 'https://claude.ai/api/mcp/auth_callback',
      code_challenge: challenge,
      code_challenge_method: 'S256',
      scope: 'library:read',
      state: 'opaque-state',
    })

    // Without consent the user is shown the approval screen, not redirected.
    const consent = await request(`/oauth/authorize?${params}`, { headers: { Cookie: cookie } })
    expect(consent.status).toBe(200)
    expect(await consent.text()).toContain('Test Connector')

    params.set('approved', 'yes')
    const approved = await request(`/oauth/authorize?${params}`, {
      headers: { Cookie: cookie },
      redirect: 'manual',
    })
    expect(approved.status).toBe(302)

    const redirect = new URL(approved.headers.get('location')!)
    expect(redirect.searchParams.get('state')).toBe('opaque-state')
    const code = redirect.searchParams.get('code')!

    const tokenResponse = await request('/oauth/token', {
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
    const token = (await tokenResponse.json()) as { access_token: string; scope: string }
    expect(tokenResponse.status).toBe(200)
    expect(token.scope).toBe('library:read')

    // The token now works against the API.
    const listed = await request('/api/v1/assets', {
      headers: { Authorization: `Bearer ${token.access_token}` },
    })
    const page = (await listed.json()) as { items: Array<{ id: string }> }
    expect(listed.status).toBe(200)
    expect(page.items[0]!.id).toBe(uploaded.asset.id)

    // ...but only within the scope that was granted.
    const write = await jsonRequest(
      '/api/v1/assets/trash',
      'POST',
      { assetIds: [uploaded.asset.id] },
      undefined,
    )
    expect(write.status).toBe(401)

    const scoped = await request('/api/v1/assets/trash', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token.access_token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ assetIds: [uploaded.asset.id] }),
    })
    expect(scoped.status).toBe(403)
  })

  test('refuses to redirect to an unregistered URI', async () => {
    const { cookie } = await signUp()
    const client = (await (
      await jsonRequest('/oauth/register', 'POST', {
        client_name: 'Test',
        redirect_uris: ['https://claude.ai/api/mcp/auth_callback'],
        token_endpoint_auth_method: 'none',
      })
    ).json()) as { client_id: string }

    const response = await request(
      `/oauth/authorize?${new URLSearchParams({
        response_type: 'code',
        client_id: client.client_id,
        redirect_uri: 'https://attacker.example.com/steal',
        code_challenge: 'x'.repeat(43),
        code_challenge_method: 'S256',
      })}`,
      { headers: { Cookie: cookie }, redirect: 'manual' },
    )

    expect(response.status).toBe(400)
  })
})

describe('MCP endpoint', () => {
  const rpc = (body: unknown, token?: string) =>
    request('/mcp', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
    })

  async function connectorToken(scope = 'library:read albums:read albums:write') {
    const { cookie } = await signUp()
    const client = (await (
      await jsonRequest('/oauth/register', 'POST', {
        client_name: 'Claude',
        redirect_uris: ['https://claude.ai/api/mcp/auth_callback'],
        token_endpoint_auth_method: 'none',
      })
    ).json()) as { client_id: string }

    const verifier = randomBytes(32).toString('base64url')
    const challenge = createHash('sha256').update(verifier).digest('base64url')
    const params = new URLSearchParams({
      response_type: 'code',
      client_id: client.client_id,
      redirect_uri: 'https://claude.ai/api/mcp/auth_callback',
      code_challenge: challenge,
      code_challenge_method: 'S256',
      scope,
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

    return { token: token.access_token, cookie }
  }

  test('initialize works before authenticating, so a client can discover the server', async () => {
    const response = await rpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })
    const body = (await response.json()) as { result: { serverInfo: { name: string } } }

    expect(response.status).toBe(200)
    expect(body.result.serverInfo.name).toBe('imogen')
  })

  test('listing tools without a token returns 401 with the metadata pointer', async () => {
    const response = await rpc({ jsonrpc: '2.0', id: 1, method: 'tools/list' })

    expect(response.status).toBe(401)
    expect(response.headers.get('www-authenticate')).toContain('oauth-protected-resource')
  })

  test('lists the tools an authorized connector may use', async () => {
    const { token } = await connectorToken()

    const response = await rpc({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, token)
    const body = (await response.json()) as { result: { tools: Array<{ name: string }> } }

    const names = body.result.tools.map((t) => t.name)
    expect(names).toContain('search_photos')
    expect(names).toContain('get_photo_image')
  })

  test('hides tools the connector was not granted', async () => {
    const { token } = await connectorToken('library:read')

    const response = await rpc({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, token)
    const body = (await response.json()) as { result: { tools: Array<{ name: string }> } }

    const names = body.result.tools.map((t) => t.name)
    expect(names).toContain('search_photos')
    expect(names).not.toContain('create_album')
  })

  test('refuses to run a tool outside the granted scope', async () => {
    const { token } = await connectorToken('library:read')

    const response = await rpc(
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'create_album', arguments: { name: 'Sneaky' } },
      },
      token,
    )
    const body = (await response.json()) as { error: { message: string } }

    expect(body.error.message).toContain('albums:write')
  })

  test('searches the library through a tool call', async () => {
    const { token, cookie } = await connectorToken()
    await upload(cookie, await makePhoto('harbour-sunset.jpg'))
    await services.queue.drain()

    const response = await rpc(
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'search_photos', arguments: { query: 'harbour' } },
      },
      token,
    )
    const body = (await response.json()) as {
      result: { content: Array<{ type: string; text: string }> }
    }

    expect(body.result.content[0]!.text).toContain('harbour-sunset.jpg')
  })

  test('returns an actual image for get_photo_image', async () => {
    const { token, cookie } = await connectorToken()
    const uploaded = (await (await upload(cookie, await makePhoto())).json()) as {
      asset: { id: string }
    }
    await services.queue.drain()

    const response = await rpc(
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'get_photo_image', arguments: { photoId: uploaded.asset.id } },
      },
      token,
    )
    const body = (await response.json()) as {
      result: { content: Array<{ type: string; mimeType?: string; data?: string }> }
    }

    const image = body.result.content.find((c) => c.type === 'image')
    expect(image?.mimeType).toBe('image/webp')
    expect(Buffer.from(image!.data!, 'base64').length).toBeGreaterThan(0)
  })

  test('a tool failure comes back as a readable result, not a protocol error', async () => {
    const { token } = await connectorToken()

    const response = await rpc(
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: 'get_photo',
          arguments: { photoId: '00000000-0000-4000-8000-000000000000' },
        },
      },
      token,
    )
    const body = (await response.json()) as { result: { isError: boolean } }

    expect(body.result.isError).toBe(true)
  })

  test('one connector cannot reach another user’s library', async () => {
    const intruder = await connectorToken()
    const victim = await signUp('victim@example.com')
    await upload(victim.cookie, await makePhoto('private.jpg'))
    await services.queue.drain()

    const response = await rpc(
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'search_photos', arguments: {} },
      },
      intruder.token,
    )
    const body = (await response.json()) as {
      result: { content: Array<{ text: string }> }
    }

    expect(body.result.content[0]!.text).not.toContain('private.jpg')
  })
})

describe('sharing a single photograph', () => {
  /** Uploads and returns the asset, since the helper hands back the response. */
  const addPhoto = async (cookie: string, name: string) => {
    const response = await upload(cookie, await makePhoto(name))
    return (await response.json()) as { asset: { id: string } }
  }

  test('the link opens the photo without signing in', async () => {
    const { cookie } = await signUp()
    const { asset } = await addPhoto(cookie, 'shared.jpg')

    const created = await jsonRequest(`/api/v1/assets/${asset.id}/share`, 'POST', {}, cookie)
    expect(created.status).toBe(201)
    const link = (await created.json()) as { slug: string; assetId: string; albumId: string | null }
    expect(link.assetId).toBe(asset.id)
    expect(link.albumId).toBeNull()

    const opened = await request(`/api/v1/share/${link.slug}`)
    const body = (await opened.json()) as { album: { assets: Array<{ id: string }> } }

    expect(opened.status).toBe(200)
    expect(body.album.assets.map((a) => a.id)).toEqual([asset.id])
  })

  test('every variant the page asks for is served without a session', async () => {
    const { cookie } = await signUp()
    const { asset } = await addPhoto(cookie, 'shared.jpg')
    const created = await jsonRequest(`/api/v1/assets/${asset.id}/share`, 'POST', {}, cookie)
    const { slug } = (await created.json()) as { slug: string }
    await services.queue.drain()

    // The grid asks for a thumbnail, the viewer for a preview, the download for the
    // original. A page that renders with every image missing is what happens when one
    // of these is only reachable with a session.
    for (const variant of ['thumbnail', 'preview', 'original']) {
      const response = await request(`/api/v1/share/${slug}/assets/${asset.id}/${variant}`)
      expect({ variant, status: response.status }).toEqual({ variant, status: 200 })
    }
  })

  test('the original is refused when the link says no downloads', async () => {
    const { cookie } = await signUp()
    const { asset } = await addPhoto(cookie, 'shared.jpg')
    const created = await jsonRequest(
      `/api/v1/assets/${asset.id}/share`,
      'POST',
      { allowDownload: false },
      cookie,
    )
    const { slug } = (await created.json()) as { slug: string }
    await services.queue.drain()

    expect((await request(`/api/v1/share/${slug}/assets/${asset.id}/preview`)).status).toBe(200)
    expect((await request(`/api/v1/share/${slug}/assets/${asset.id}/original`)).status).toBe(404)
  })

  test('the page is told it is a photo, not an album', async () => {
    const { cookie } = await signUp()
    const { asset } = await addPhoto(cookie, 'shared.jpg')
    const created = await jsonRequest(`/api/v1/assets/${asset.id}/share`, 'POST', {}, cookie)
    const { slug } = (await created.json()) as { slug: string }

    const opened = await request(`/api/v1/share/${slug}`)
    const body = (await opened.json()) as { kind: string }

    expect(body.kind).toBe('photo')
  })

  test('a slug for one photo is not a key to the rest of the library', async () => {
    const { cookie } = await signUp()
    const shared = await addPhoto(cookie, 'shared.jpg')
    const other = await addPhoto(cookie, 'private.jpg')

    const created = await jsonRequest(`/api/v1/assets/${shared.asset.id}/share`, 'POST', {}, cookie)
    const { slug } = (await created.json()) as { slug: string }

    // The preview is made by the queue, so serving one means waiting for it.
    await services.queue.drain()

    const reachable = await request(`/api/v1/share/${slug}/assets/${shared.asset.id}/preview`)
    const refused = await request(`/api/v1/share/${slug}/assets/${other.asset.id}/preview`)

    expect(reachable.status).toBe(200)
    expect(refused.status).toBe(404)
  })

  test('revoking closes the link', async () => {
    const { cookie } = await signUp()
    const { asset } = await addPhoto(cookie, 'shared.jpg')
    const created = await jsonRequest(`/api/v1/assets/${asset.id}/share`, 'POST', {}, cookie)
    const { slug } = (await created.json()) as { slug: string }

    await request(`/api/v1/assets/${asset.id}/share`, {
      method: 'DELETE',
      headers: { Cookie: cookie },
    })

    expect((await request(`/api/v1/share/${slug}`)).status).toBe(404)
  })

  test('a photo has at most one live link', async () => {
    const { cookie } = await signUp()
    const { asset } = await addPhoto(cookie, 'shared.jpg')

    const first = await jsonRequest(`/api/v1/assets/${asset.id}/share`, 'POST', {}, cookie)
    const firstSlug = ((await first.json()) as { slug: string }).slug
    const second = await jsonRequest(`/api/v1/assets/${asset.id}/share`, 'POST', {}, cookie)
    const secondSlug = ((await second.json()) as { slug: string }).slug

    expect((await request(`/api/v1/share/${firstSlug}`)).status).toBe(404)
    expect((await request(`/api/v1/share/${secondSlug}`)).status).toBe(200)
  })

  test('somebody else’s photo cannot be shared', async () => {
    const owner = await signUp('owner@example.com')
    const { asset } = await addPhoto(owner.cookie, 'mine.jpg')
    const stranger = await signUp('stranger@example.com')

    const response = await jsonRequest(
      `/api/v1/assets/${asset.id}/share`,
      'POST',
      {},
      stranger.cookie,
    )

    expect(response.status).toBe(404)
  })
})

describe('OIDC routes are reachable without a session', () => {
  // Regression: `authed` carries `use('*', requireAuth())` and used to be mounted at
  // '/' before these two routes were registered, so Hono ran requireAuth() first and
  // answered both with 401. That made single sign-on impossible to start and the
  // provider's callback impossible to complete. Signing in is by definition the one
  // request that has no session yet, so these must sit outside the authed sub-app.
  //
  // This server has no OIDC provider configured, so the correct answer is 400 ("not
  // configured"). The point is what it is NOT: a 401. A 401 means requireAuth() ran,
  // which means the ordering has regressed.
  test('/auth/oidc/start is not gated by requireAuth', async () => {
    const response = await request('/api/v1/auth/oidc/start')
    expect(response.status).not.toBe(401)
    expect(response.status).toBe(400)
  })

  test('/auth/oidc/callback is not gated by requireAuth', async () => {
    const response = await request('/api/v1/auth/oidc/callback?code=irrelevant')
    expect(response.status).not.toBe(401)
    expect(response.status).toBe(400)
  })
})
