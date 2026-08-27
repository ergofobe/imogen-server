import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { createHash, randomBytes } from 'node:crypto'
import { eq, sql } from 'drizzle-orm'
import type { Database } from '../db/index.ts'
import { pairingTickets, users } from '../db/schema.ts'
import { createTestDatabase } from '../test/harness.ts'
import { OAuthError, OAuthService } from './oauth.ts'
import { PairingService } from './pairing.ts'

const harness = await createTestDatabase()
const db: Database = harness.db
const oauth = new OAuthService(db, { publicUrl: 'https://photos.example.com' })
const pairing = new PairingService(db, oauth, { publicUrl: 'https://photos.example.com' })

afterAll(() => harness.close())

let userId: string
let clientId: string

const REDIRECT = 'imogen://oauth'

function pkce() {
  const verifier = randomBytes(32).toString('base64url')
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') }
}

beforeEach(async () => {
  await db.execute(
    sql`truncate pairing_tickets, oauth_tokens, oauth_auth_codes, oauth_clients, users cascade`,
  )
  const [user] = await db
    .insert(users)
    .values({ email: 'owner@example.com', name: 'Owner' })
    .returning()
  userId = user!.id

  const client = await oauth.registerClient({
    client_name: 'imogen for Android',
    redirect_uris: [REDIRECT],
    token_endpoint_auth_method: 'none',
  })
  clientId = client.client_id
})

function claimInput(code: string, challenge: string, overrides: Record<string, unknown> = {}) {
  return {
    code,
    clientId,
    redirectUri: REDIRECT,
    codeChallenge: challenge,
    codeChallengeMethod: 'S256' as const,
    deviceName: 'Pixel 8',
    ...overrides,
  }
}

describe('making a ticket', () => {
  test('carries the server address, so the device is never asked for it', async () => {
    const ticket = await pairing.create(userId)

    expect(ticket.serverUrl).toBe('https://photos.example.com')
    expect(ticket.uri).toStartWith('imogen://pair?server=')
    expect(ticket.uri).toContain(encodeURIComponent(ticket.code))
  })

  test('stores only a hash of the code', async () => {
    const ticket = await pairing.create(userId)

    const [row] = await db.select().from(pairingTickets).where(eq(pairingTickets.id, ticket.id))
    expect(row!.codeHash).not.toBe(ticket.code)
    expect(row!.codeHash).toBe(createHash('sha256').update(ticket.code).digest('hex'))
  })

  test('sweeps tickets that have already expired', async () => {
    const stale = await pairing.create(userId)
    await db
      .update(pairingTickets)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(pairingTickets.id, stale.id))

    await pairing.create(userId)

    const rows = await db.select().from(pairingTickets)
    expect(rows.map((r) => r.id)).not.toContain(stale.id)
  })
})

describe('claiming a ticket', () => {
  test('yields an authorization code that completes with the verifier', async () => {
    const ticket = await pairing.create(userId)
    const { verifier, challenge } = pkce()

    const claim = await pairing.claim(claimInput(ticket.code, challenge))
    const tokens = await oauth.exchangeAuthorizationCode({
      clientId,
      code: claim.code,
      codeVerifier: verifier,
      redirectUri: REDIRECT,
    })

    expect(tokens.access_token).toBeString()
    expect(tokens.refresh_token).toBeString()
    const principal = await oauth.verifyAccessToken(tokens.access_token)
    expect(principal!.userId).toBe(userId)
  })

  test('grants the library and album scopes a phone needs, and nothing else', async () => {
    const ticket = await pairing.create(userId)

    const claim = await pairing.claim(claimInput(ticket.code, pkce().challenge))

    expect(claim.scope.split(' ').sort()).toEqual([
      'albums:read',
      'albums:write',
      'library:read',
      'library:write',
      'profile',
    ])
  })

  test('narrows to the scopes a device asked for', async () => {
    const ticket = await pairing.create(userId)

    const claim = await pairing.claim(
      claimInput(ticket.code, pkce().challenge, { scope: 'library:read nonsense' }),
    )

    expect(claim.scope).toBe('library:read')
  })

  test('the code alone is not enough without the verifier', async () => {
    const ticket = await pairing.create(userId)

    const claim = await pairing.claim(claimInput(ticket.code, pkce().challenge))

    await expect(
      oauth.exchangeAuthorizationCode({
        clientId,
        code: claim.code,
        codeVerifier: randomBytes(32).toString('base64url'),
        redirectUri: REDIRECT,
      }),
    ).rejects.toThrow(OAuthError)
  })

  test('records the device name, so the browser can say what paired', async () => {
    const ticket = await pairing.create(userId)
    await pairing.claim(claimInput(ticket.code, pkce().challenge))

    const status = await pairing.status(userId, ticket.id)
    expect(status!.claimedAt).toBeString()
    expect(status!.deviceName).toBe('Pixel 8')
  })

  test('a ticket is spent once', async () => {
    const ticket = await pairing.create(userId)
    await pairing.claim(claimInput(ticket.code, pkce().challenge))

    await expect(pairing.claim(claimInput(ticket.code, pkce().challenge))).rejects.toThrow(
      OAuthError,
    )
  })

  test('an expired ticket is refused', async () => {
    const ticket = await pairing.create(userId)
    await db
      .update(pairingTickets)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(pairingTickets.id, ticket.id))

    await expect(pairing.claim(claimInput(ticket.code, pkce().challenge))).rejects.toThrow(
      OAuthError,
    )
  })

  test('an unknown code is refused in exactly the same words as a spent one', async () => {
    const ticket = await pairing.create(userId)
    await pairing.claim(claimInput(ticket.code, pkce().challenge))

    const spent = await pairing.claim(claimInput(ticket.code, pkce().challenge)).catch((e) => e)
    const unknown = await pairing
      .claim(claimInput('imog_pair_nope', pkce().challenge))
      .catch((e) => e)

    expect(unknown.message).toBe(spent.message)
  })

  test('refuses a redirect the client did not register', async () => {
    const ticket = await pairing.create(userId)

    await expect(
      pairing.claim(claimInput(ticket.code, pkce().challenge, { redirectUri: 'evil://oauth' })),
    ).rejects.toThrow(OAuthError)
  })
})

describe('watching a ticket', () => {
  test('is unclaimed until something claims it', async () => {
    const ticket = await pairing.create(userId)

    const status = await pairing.status(userId, ticket.id)
    expect(status!.claimedAt).toBeNull()
    expect(status!.deviceName).toBeNull()
  })

  test('someone else’s ticket is not found rather than refused', async () => {
    const ticket = await pairing.create(userId)
    const [other] = await db
      .insert(users)
      .values({ email: 'other@example.com', name: 'Other' })
      .returning()

    expect(await pairing.status(other!.id, ticket.id)).toBeNull()
  })
})
