import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { createHash, randomBytes } from 'node:crypto'
import { sql } from 'drizzle-orm'
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
    sql`truncate pairing_tickets, users, oauth_clients, oauth_tokens, oauth_auth_codes, sessions cascade`,
  )
})

const REDIRECT = 'imogen://oauth'

const request = (path: string, init: RequestInit = {}) =>
  app.fetch(new Request(`http://localhost:3000${path}`, init))

const postJson = (path: string, body: unknown, cookie?: string) =>
  request(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
    body: JSON.stringify(body),
  })

async function signUp() {
  const response = await postJson('/api/v1/auth/signup', {
    email: 'owner@example.com',
    password: 'a-sufficiently-long-password',
    name: 'Owner',
  })
  return response.headers.get('set-cookie')?.split(';')[0] ?? ''
}

/** Everything a fresh device does, in the order it does it. */
async function registerDevice() {
  const response = await postJson('/oauth/register', {
    client_name: 'imogen for Android',
    redirect_uris: [REDIRECT],
    token_endpoint_auth_method: 'none',
  })
  const { client_id } = (await response.json()) as { client_id: string }
  const verifier = randomBytes(32).toString('base64url')
  return {
    clientId: client_id,
    verifier,
    challenge: createHash('sha256').update(verifier).digest('base64url'),
  }
}

describe('POST /api/v1/pairing', () => {
  test('needs a signed-in browser', async () => {
    expect((await postJson('/api/v1/pairing', {})).status).toBe(401)
  })

  test('hands back a code and the address to spend it at', async () => {
    const cookie = await signUp()

    const response = await postJson('/api/v1/pairing', {}, cookie)
    const ticket = (await response.json()) as { code: string; uri: string; serverUrl: string }

    expect(response.status).toBe(201)
    expect(ticket.serverUrl).toBe('http://localhost:3000')
    expect(ticket.uri).toContain('imogen://pair?server=')
  })

  test('a paired device cannot mint more tickets for itself', async () => {
    const cookie = await signUp()
    const ticket = (await (await postJson('/api/v1/pairing', {}, cookie)).json()) as {
      code: string
    }
    const device = await registerDevice()
    const claim = (await (
      await postJson('/api/v1/pairing/claim', {
        code: ticket.code,
        clientId: device.clientId,
        redirectUri: REDIRECT,
        codeChallenge: device.challenge,
        codeChallengeMethod: 'S256',
      })
    ).json()) as { code: string }

    const tokens = (await (
      await request('/oauth/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          client_id: device.clientId,
          code: claim.code,
          code_verifier: device.verifier,
          redirect_uri: REDIRECT,
        }),
      })
    ).json()) as { access_token: string }

    const response = await request('/api/v1/pairing', {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokens.access_token}` },
    })
    expect(response.status).toBe(400)
  })
})

describe('POST /api/v1/pairing/claim', () => {
  test('runs the whole flow: register, claim, exchange, and read the library', async () => {
    const cookie = await signUp()
    const ticket = (await (await postJson('/api/v1/pairing', {}, cookie)).json()) as {
      id: string
      code: string
    }
    const device = await registerDevice()

    const claimResponse = await postJson('/api/v1/pairing/claim', {
      code: ticket.code,
      clientId: device.clientId,
      redirectUri: REDIRECT,
      codeChallenge: device.challenge,
      codeChallengeMethod: 'S256',
      deviceName: 'Pixel 8',
    })
    expect(claimResponse.status).toBe(200)
    const claim = (await claimResponse.json()) as { code: string }

    const tokenResponse = await request('/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: device.clientId,
        code: claim.code,
        code_verifier: device.verifier,
        redirect_uri: REDIRECT,
      }),
    })
    const tokens = (await tokenResponse.json()) as { access_token: string }

    const me = await request('/api/v1/auth/me', {
      headers: { Authorization: `Bearer ${tokens.access_token}` },
    })
    expect(me.status).toBe(200)
    expect(((await me.json()) as { email: string }).email).toBe('owner@example.com')

    const status = await request(`/api/v1/pairing/${ticket.id}`, { headers: { Cookie: cookie } })
    expect(((await status.json()) as { deviceName: string }).deviceName).toBe('Pixel 8')
  })

  test('refuses a code nobody issued', async () => {
    const device = await registerDevice()

    const response = await postJson('/api/v1/pairing/claim', {
      code: 'imog_pair_not-a-real-code',
      clientId: device.clientId,
      redirectUri: REDIRECT,
      codeChallenge: device.challenge,
      codeChallengeMethod: 'S256',
    })
    expect(response.status).toBe(400)
  })
})
