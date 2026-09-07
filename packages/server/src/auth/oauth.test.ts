import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { createHash, randomBytes } from 'node:crypto'
import { eq, sql } from 'drizzle-orm'
import type { Database } from '../db/index.ts'
import { oauthTokens, users } from '../db/schema.ts'
import { createTestDatabase } from '../test/harness.ts'
import { OAuthError, OAuthService } from './oauth.ts'

const harness = await createTestDatabase()
const db: Database = harness.db
const oauth = new OAuthService(db, { publicUrl: 'https://photos.example.com' })

afterAll(() => harness.close())

let userId: string

beforeEach(async () => {
  await db.execute(sql`truncate oauth_tokens, oauth_auth_codes, oauth_clients, users cascade`)
  const [user] = await db
    .insert(users)
    .values({ email: 'owner@example.com', name: 'Owner' })
    .returning()
  userId = user!.id
})

function pkce() {
  const verifier = randomBytes(32).toString('base64url')
  const challenge = createHash('sha256').update(verifier).digest('base64url')
  return { verifier, challenge }
}

async function registerClient(overrides: Record<string, unknown> = {}) {
  return oauth.registerClient({
    client_name: 'Test Client',
    redirect_uris: ['https://client.example.com/callback'],
    ...overrides,
  })
}

async function authorize(clientId: string, challenge: string, scopes = ['library:read']) {
  return oauth.issueAuthorizationCode({
    clientId,
    userId,
    redirectUri: 'https://client.example.com/callback',
    scopes,
    codeChallenge: challenge,
    codeChallengeMethod: 'S256',
  })
}

describe('dynamic client registration', () => {
  test('issues a public client with no secret when auth method is none', async () => {
    const client = await registerClient({ token_endpoint_auth_method: 'none' })

    expect(client.client_id).toBeString()
    expect(client.client_secret).toBeUndefined()
    expect(client.token_endpoint_auth_method).toBe('none')
  })

  test('issues a secret for confidential clients', async () => {
    const client = await registerClient({ token_endpoint_auth_method: 'client_secret_post' })

    expect(client.client_secret).toBeString()
    expect(client.client_secret!.length).toBeGreaterThanOrEqual(32)
  })

  test('rejects a redirect uri that is neither https nor loopback', async () => {
    await expect(registerClient({ redirect_uris: ['http://evil.example.com/cb'] })).rejects.toThrow(
      OAuthError,
    )
  })

  test('accepts http loopback redirects so native apps can register', async () => {
    const client = await registerClient({ redirect_uris: ['http://127.0.0.1:49152/callback'] })

    expect(client.redirect_uris).toEqual(['http://127.0.0.1:49152/callback'])
  })

  test('accepts a reverse-DNS private-use scheme', async () => {
    const client = await registerClient({ redirect_uris: ['com.example.app:/oauth'] })

    expect(client.redirect_uris).toEqual(['com.example.app:/oauth'])
  })

  test('accepts a plain private-use scheme, which is what most mobile apps use', async () => {
    const client = await registerClient({ redirect_uris: ['myapp://oauth'] })

    expect(client.redirect_uris).toEqual(['myapp://oauth'])
  })

  test('still rejects plain http to a remote host', async () => {
    await expect(registerClient({ redirect_uris: ['http://evil.example.com/cb'] })).rejects.toThrow(
      'invalid_redirect_uri',
    )
  })

  test('narrows requested scopes to those imogen actually grants', async () => {
    const client = await registerClient({ scope: 'library:read library:write admin:everything' })

    expect(client.scope.split(' ')).toEqual(['library:read', 'library:write'])
  })
})

describe('authorization code exchange', () => {
  test('exchanges a valid code with the matching verifier', async () => {
    const client = await registerClient({ token_endpoint_auth_method: 'none' })
    const { verifier, challenge } = pkce()
    const code = await authorize(client.client_id, challenge)

    const token = await oauth.exchangeAuthorizationCode({
      clientId: client.client_id,
      code,
      codeVerifier: verifier,
      redirectUri: 'https://client.example.com/callback',
    })

    expect(token.token_type).toBe('Bearer')
    expect(token.access_token).toBeString()
    expect(token.refresh_token).toBeString()
    expect(token.scope).toBe('library:read')
  })

  test('rejects a code presented with the wrong verifier', async () => {
    const client = await registerClient({ token_endpoint_auth_method: 'none' })
    const { challenge } = pkce()
    const code = await authorize(client.client_id, challenge)

    await expect(
      oauth.exchangeAuthorizationCode({
        clientId: client.client_id,
        code,
        codeVerifier: pkce().verifier,
        redirectUri: 'https://client.example.com/callback',
      }),
    ).rejects.toThrow('invalid_grant')
  })

  test('rejects a replayed code and revokes the tokens it already issued', async () => {
    const client = await registerClient({ token_endpoint_auth_method: 'none' })
    const { verifier, challenge } = pkce()
    const code = await authorize(client.client_id, challenge)

    const first = await oauth.exchangeAuthorizationCode({
      clientId: client.client_id,
      code,
      codeVerifier: verifier,
      redirectUri: 'https://client.example.com/callback',
    })

    await expect(
      oauth.exchangeAuthorizationCode({
        clientId: client.client_id,
        code,
        codeVerifier: verifier,
        redirectUri: 'https://client.example.com/callback',
      }),
    ).rejects.toThrow('invalid_grant')

    // A replay means the code leaked, so the first exchange is no longer trustworthy.
    expect(await oauth.verifyAccessToken(first.access_token)).toBeNull()
  })

  test('rejects a code redeemed against a different redirect uri', async () => {
    const client = await registerClient({
      token_endpoint_auth_method: 'none',
      redirect_uris: ['https://client.example.com/callback', 'https://client.example.com/other'],
    })
    const { verifier, challenge } = pkce()
    const code = await authorize(client.client_id, challenge)

    await expect(
      oauth.exchangeAuthorizationCode({
        clientId: client.client_id,
        code,
        codeVerifier: verifier,
        redirectUri: 'https://client.example.com/other',
      }),
    ).rejects.toThrow('invalid_grant')
  })

  test('rejects a code redeemed by a different client', async () => {
    const client = await registerClient({ token_endpoint_auth_method: 'none' })
    const other = await registerClient({ token_endpoint_auth_method: 'none' })
    const { verifier, challenge } = pkce()
    const code = await authorize(client.client_id, challenge)

    await expect(
      oauth.exchangeAuthorizationCode({
        clientId: other.client_id,
        code,
        codeVerifier: verifier,
        redirectUri: 'https://client.example.com/callback',
      }),
    ).rejects.toThrow('invalid_grant')
  })

  test('rejects an expired code', async () => {
    const client = await registerClient({ token_endpoint_auth_method: 'none' })
    const { verifier, challenge } = pkce()
    const code = await oauth.issueAuthorizationCode({
      clientId: client.client_id,
      userId,
      redirectUri: 'https://client.example.com/callback',
      scopes: ['library:read'],
      codeChallenge: challenge,
      codeChallengeMethod: 'S256',
      ttlSeconds: -1,
    })

    await expect(
      oauth.exchangeAuthorizationCode({
        clientId: client.client_id,
        code,
        codeVerifier: verifier,
        redirectUri: 'https://client.example.com/callback',
      }),
    ).rejects.toThrow('invalid_grant')
  })

  test('rejects the plain PKCE method', async () => {
    const client = await registerClient({ token_endpoint_auth_method: 'none' })

    await expect(
      oauth.issueAuthorizationCode({
        clientId: client.client_id,
        userId,
        redirectUri: 'https://client.example.com/callback',
        scopes: ['library:read'],
        codeChallenge: 'a-plain-verifier-value-used-directly',
        codeChallengeMethod: 'plain',
      }),
    ).rejects.toThrow(OAuthError)
  })

  test('requires the secret from a confidential client', async () => {
    const client = await registerClient({ token_endpoint_auth_method: 'client_secret_post' })
    const { verifier, challenge } = pkce()
    const code = await authorize(client.client_id, challenge)

    await expect(
      oauth.exchangeAuthorizationCode({
        clientId: client.client_id,
        code,
        codeVerifier: verifier,
        redirectUri: 'https://client.example.com/callback',
      }),
    ).rejects.toThrow('invalid_client')

    const token = await oauth.exchangeAuthorizationCode({
      clientId: client.client_id,
      clientSecret: client.client_secret,
      code,
      codeVerifier: verifier,
      redirectUri: 'https://client.example.com/callback',
    })
    expect(token.access_token).toBeString()
  })
})

describe('refresh token rotation', () => {
  async function grant(scopes = ['library:read']) {
    const client = await registerClient({ token_endpoint_auth_method: 'none' })
    const { verifier, challenge } = pkce()
    const code = await authorize(client.client_id, challenge, scopes)
    const token = await oauth.exchangeAuthorizationCode({
      clientId: client.client_id,
      code,
      codeVerifier: verifier,
      redirectUri: 'https://client.example.com/callback',
    })
    return { clientId: client.client_id, token }
  }

  test('returns a new pair and invalidates the old refresh token', async () => {
    const { clientId, token } = await grant()

    const refreshed = await oauth.refresh({ clientId, refreshToken: token.refresh_token! })

    expect(refreshed.refresh_token).not.toBe(token.refresh_token)
    expect(refreshed.access_token).not.toBe(token.access_token)
    expect(await oauth.verifyAccessToken(refreshed.access_token)).not.toBeNull()
  })

  test('revokes the whole family when a rotated refresh token is replayed', async () => {
    const { clientId, token } = await grant()
    const second = await oauth.refresh({ clientId, refreshToken: token.refresh_token! })

    await expect(oauth.refresh({ clientId, refreshToken: token.refresh_token! })).rejects.toThrow(
      'invalid_grant',
    )

    // Reuse means the token leaked; the attacker's newer token must die too.
    await expect(oauth.refresh({ clientId, refreshToken: second.refresh_token! })).rejects.toThrow(
      'invalid_grant',
    )
    expect(await oauth.verifyAccessToken(second.access_token)).toBeNull()
  })

  test('cannot widen scope on refresh', async () => {
    const { clientId, token } = await grant(['library:read'])

    await expect(
      oauth.refresh({
        clientId,
        refreshToken: token.refresh_token!,
        scope: 'library:read library:write',
      }),
    ).rejects.toThrow('invalid_scope')
  })

  test('may narrow scope on refresh', async () => {
    const { clientId, token } = await grant(['library:read', 'library:write'])

    const refreshed = await oauth.refresh({
      clientId,
      refreshToken: token.refresh_token!,
      scope: 'library:read',
    })

    expect(refreshed.scope).toBe('library:read')
  })

  test('rejects a refresh token belonging to another client', async () => {
    const { token } = await grant()
    const other = await registerClient({ token_endpoint_auth_method: 'none' })

    await expect(
      oauth.refresh({ clientId: other.client_id, refreshToken: token.refresh_token! }),
    ).rejects.toThrow('invalid_grant')
  })
})

describe('access token verification', () => {
  async function accessToken(scopes: string[]) {
    const client = await registerClient({ token_endpoint_auth_method: 'none' })
    const { verifier, challenge } = pkce()
    const code = await authorize(client.client_id, challenge, scopes)
    return oauth.exchangeAuthorizationCode({
      clientId: client.client_id,
      code,
      codeVerifier: verifier,
      redirectUri: 'https://client.example.com/callback',
    })
  }

  test('resolves the user and granted scopes', async () => {
    const token = await accessToken(['library:read', 'albums:read'])

    const principal = await oauth.verifyAccessToken(token.access_token)

    expect(principal?.userId).toBe(userId)
    expect(principal?.scopes).toEqual(['library:read', 'albums:read'])
  })

  test('rejects an unknown token', async () => {
    expect(await oauth.verifyAccessToken('not-a-real-token')).toBeNull()
  })

  test('rejects an expired token', async () => {
    const token = await accessToken(['library:read'])
    await db
      .update(oauthTokens)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(oauthTokens.kind, 'access'))

    expect(await oauth.verifyAccessToken(token.access_token)).toBeNull()
  })

  test('rejects a refresh token presented as an access token', async () => {
    const token = await accessToken(['library:read'])

    expect(await oauth.verifyAccessToken(token.refresh_token!)).toBeNull()
  })

  test('stores only hashes, never the tokens themselves', async () => {
    const token = await accessToken(['library:read'])

    const rows = await db.select().from(oauthTokens)
    const stored = rows.map((r) => r.tokenHash)
    expect(stored).not.toContain(token.access_token)
    expect(stored).toContain(createHash('sha256').update(token.access_token).digest('hex'))
  })
})

describe('metadata documents', () => {
  test('authorization server metadata advertises PKCE and registration', () => {
    const meta = oauth.authorizationServerMetadata()

    expect(meta.issuer).toBe('https://photos.example.com')
    expect(meta.code_challenge_methods_supported).toEqual(['S256'])
    expect(meta.registration_endpoint).toBe('https://photos.example.com/oauth/register')
    expect(meta.grant_types_supported).toContain('authorization_code')
    expect(meta.grant_types_supported).toContain('refresh_token')
  })

  test('protected resource metadata points connectors at this server', () => {
    const meta = oauth.protectedResourceMetadata()

    expect(meta.resource).toBe('https://photos.example.com')
    expect(meta.authorization_servers).toEqual(['https://photos.example.com'])
  })

  test('the MCP document names the endpoint it protects, not the site root', () => {
    const meta = oauth.protectedResourceMetadata('/mcp')

    expect(meta.resource).toBe('https://photos.example.com/mcp')
    expect(meta.authorization_servers).toEqual(['https://photos.example.com'])
  })
})

describe('resource indicators', () => {
  const MCP = 'https://photos.example.com/mcp'
  const ROOT = 'https://photos.example.com'

  async function tokenFor(resource?: string) {
    const client = await registerClient({ token_endpoint_auth_method: 'none' })
    const { verifier, challenge } = pkce()
    const code = await oauth.issueAuthorizationCode({
      clientId: client.client_id,
      userId,
      redirectUri: 'https://client.example.com/callback',
      scopes: ['library:read'],
      codeChallenge: challenge,
      codeChallengeMethod: 'S256',
      resource,
    })
    const token = await oauth.exchangeAuthorizationCode({
      clientId: client.client_id,
      code,
      codeVerifier: verifier,
      redirectUri: 'https://client.example.com/callback',
    })
    return { client, token }
  }

  test('carries the requested resource from the code onto the token it mints', async () => {
    const { token } = await tokenFor(MCP)

    const principal = await oauth.verifyAccessToken(token.access_token)
    expect(principal?.resource).toBe(MCP)
  })

  test('leaves the audience unset when the client asks for no resource', async () => {
    const { token } = await tokenFor()

    const principal = await oauth.verifyAccessToken(token.access_token)
    expect(principal?.resource).toBeNull()
  })

  test('refuses a resource this server does not advertise', async () => {
    const client = await registerClient({ token_endpoint_auth_method: 'none' })
    const { challenge } = pkce()

    await expect(
      oauth.issueAuthorizationCode({
        clientId: client.client_id,
        userId,
        redirectUri: 'https://client.example.com/callback',
        scopes: ['library:read'],
        codeChallenge: challenge,
        codeChallengeMethod: 'S256',
        resource: 'https://photos.example.com/../evil',
      }),
    ).rejects.toThrow(OAuthError)
  })

  test('refuses a resource belonging to another origin', async () => {
    const client = await registerClient({ token_endpoint_auth_method: 'none' })
    const { challenge } = pkce()

    await expect(
      oauth.issueAuthorizationCode({
        clientId: client.client_id,
        userId,
        redirectUri: 'https://client.example.com/callback',
        scopes: ['library:read'],
        codeChallenge: challenge,
        codeChallengeMethod: 'S256',
        resource: 'https://attacker.example.com',
      }),
    ).rejects.toThrow(OAuthError)
  })

  test('treats a trailing slash on the site root as the same resource', async () => {
    const { token } = await tokenFor('https://photos.example.com/')

    const principal = await oauth.verifyAccessToken(token.access_token)
    expect(principal?.resource).toBe(ROOT)
  })

  test('refuses to exchange a code for a resource other than the one it was issued for', async () => {
    const client = await registerClient({ token_endpoint_auth_method: 'none' })
    const { verifier, challenge } = pkce()
    const code = await oauth.issueAuthorizationCode({
      clientId: client.client_id,
      userId,
      redirectUri: 'https://client.example.com/callback',
      scopes: ['library:read'],
      codeChallenge: challenge,
      codeChallengeMethod: 'S256',
      resource: MCP,
    })

    await expect(
      oauth.exchangeAuthorizationCode({
        clientId: client.client_id,
        code,
        codeVerifier: verifier,
        redirectUri: 'https://client.example.com/callback',
        resource: ROOT,
      }),
    ).rejects.toThrow(OAuthError)
  })

  test('carries the audience across a refresh', async () => {
    const { client, token } = await tokenFor(MCP)

    const refreshed = await oauth.refresh({
      clientId: client.client_id,
      refreshToken: token.refresh_token!,
    })

    const principal = await oauth.verifyAccessToken(refreshed.access_token)
    expect(principal?.resource).toBe(MCP)
  })

  test('refuses to refresh a token into a different audience', async () => {
    const { client, token } = await tokenFor(MCP)

    await expect(
      oauth.refresh({
        clientId: client.client_id,
        refreshToken: token.refresh_token!,
        resource: ROOT,
      }),
    ).rejects.toThrow(OAuthError)
  })

  test('will not let an unbound refresh token acquire an audience it never consented to', async () => {
    const { client, token } = await tokenFor()

    await expect(
      oauth.refresh({
        clientId: client.client_id,
        refreshToken: token.refresh_token!,
        resource: MCP,
      }),
    ).rejects.toThrow(OAuthError)
  })

  test('advertises that the resource parameter is honoured', () => {
    expect(oauth.authorizationServerMetadata().resource_indicators_supported).toBe(true)
  })

  // The advertised set and the accepted set are the same list or the server is lying:
  // a client that reads a protected-resource document and echoes its `resource` back
  // must not then be told that resource does not exist.
  test('accepts every resource it publishes a document for', () => {
    for (const identifier of oauth.resourceIdentifiers()) {
      expect(oauth.canonicalResource(identifier)).toBe(identifier)
    }
    expect(oauth.resourceIdentifiers()).toContain(oauth.protectedResourceMetadata().resource)
    expect(oauth.resourceIdentifiers()).toContain(oauth.protectedResourceMetadata('/mcp').resource)
  })

  // IMOGEN_PUBLIC_URL is only stripped of trailing slashes, so a deployment can hand us a
  // default port or a capitalised host. Advertising one spelling and accepting another
  // would lock every spec-compliant MCP client out of the connector flow, and the failure
  // would appear at the client, an entire OAuth round trip away from its cause.
  test.each([
    'https://Photos.Example.com',
    'https://photos.example.com:443',
    'http://photos.example.com:80',
  ])('advertises and accepts the same identifier when configured as %s', (publicUrl) => {
    const server = new OAuthService(db, { publicUrl })

    for (const path of ['', '/mcp'] as const) {
      const advertised = server.protectedResourceMetadata(path).resource
      expect(server.canonicalResource(advertised)).toBe(advertised)
      expect(server.resourceIdentifier(path)).toBe(advertised)
    }
  })
})
