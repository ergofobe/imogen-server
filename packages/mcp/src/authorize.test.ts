import { describe, expect, test } from 'bun:test'
import { type FetchLike, OAuthClient } from '@imogen/sdk'
import { beginBridgeAuthorization } from './authorize.ts'

const SERVER = 'https://photos.example.com'

/**
 * The identifier the server publishes deliberately is not `${baseUrl}/mcp`: this stands in
 * for a deployment whose `IMOGEN_PUBLIC_URL` is spelled differently from the address the
 * bridge was pointed at. A client that builds the identifier instead of reading it gets
 * `invalid_target` from the very server that published it.
 */
const PUBLISHED_MCP_RESOURCE = 'https://photos.example.com:8443/mcp'

const json = (body: unknown) =>
  new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } })

const stubServer = (): { fetch: FetchLike; requests: string[] } => {
  const requests: string[] = []

  const fetch: FetchLike = async (input) => {
    const url = typeof input === 'string' ? input : input.toString()
    requests.push(url)

    if (url.endsWith('/.well-known/oauth-authorization-server')) {
      return json({
        issuer: SERVER,
        authorization_endpoint: `${SERVER}/oauth/authorize`,
        token_endpoint: `${SERVER}/oauth/token`,
        registration_endpoint: `${SERVER}/oauth/register`,
      })
    }
    if (url.endsWith('/.well-known/oauth-protected-resource/mcp')) {
      return json({ resource: PUBLISHED_MCP_RESOURCE })
    }
    if (url.endsWith('/.well-known/oauth-protected-resource')) {
      return json({ resource: SERVER })
    }
    if (url.endsWith('/oauth/register')) {
      return json({ client_id: 'CLIENT' })
    }
    throw new Error(`unexpected request: ${url}`)
  }

  return { fetch, requests }
}

describe('starting the bridge’s authorization', () => {
  test('binds the token to /mcp rather than the whole server', async () => {
    const { fetch } = stubServer()

    const { pending } = await beginBridgeAuthorization(
      new OAuthClient(SERVER, fetch),
      'http://127.0.0.1:1234/callback',
    )

    expect(new URL(pending.authorizationUrl).searchParams.get('resource')).toBe(
      PUBLISHED_MCP_RESOURCE,
    )
  })

  test('reads the identifier from the document instead of building it', async () => {
    const { fetch, requests } = stubServer()

    const { pending } = await beginBridgeAuthorization(
      new OAuthClient(SERVER, fetch),
      'http://127.0.0.1:1234/callback',
    )

    expect(requests).toContain(`${SERVER}/.well-known/oauth-protected-resource/mcp`)
    // Not `${SERVER}/mcp`, which is what concatenation would have produced.
    expect(pending.resource).toBe(PUBLISHED_MCP_RESOURCE)
  })

  test('carries the resource on `pending`, so the token exchange cannot disagree', async () => {
    const { fetch } = stubServer()

    const { pending } = await beginBridgeAuthorization(
      new OAuthClient(SERVER, fetch),
      'http://127.0.0.1:1234/callback',
    )

    // `exchangeAuthorizationCode` refuses a token request naming a resource the code did
    // not record, so these two travelling together is the point of returning `pending`.
    expect(pending.resource).toBe(PUBLISHED_MCP_RESOURCE)
    expect(pending.resource).toBe(new URL(pending.authorizationUrl).searchParams.get('resource'))
  })

  test('registers under the redirect the loopback listener is actually on', async () => {
    const { fetch } = stubServer()

    const { clientId, pending } = await beginBridgeAuthorization(
      new OAuthClient(SERVER, fetch),
      'http://127.0.0.1:1234/callback',
    )

    expect(clientId).toBe('CLIENT')
    expect(pending.redirectUri).toBe('http://127.0.0.1:1234/callback')
  })
})
