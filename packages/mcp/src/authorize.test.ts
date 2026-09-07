import { describe, expect, test } from 'bun:test'
import { type FetchLike, OAuthClient } from '@imogen/sdk'
import { beginBridgeAuthorization } from './authorize.ts'

const SERVER = 'https://photos.example.com'

/**
 * What the server publishes is deliberately not `${SERVER}/mcp`: this stands in for a
 * deployment whose `IMOGEN_PUBLIC_URL` is spelled differently from the address the bridge
 * was pointed at. A client that builds the identifier rather than reading it is refused
 * as `invalid_target` by the very server that published the real one.
 */
const PUBLISHED_MCP_RESOURCE = 'https://photos.example.com:8443/mcp'

/** The scopes the bridge has always asked for, and which this change must not disturb. */
const DEFAULT_SCOPES = 'library:read library:write albums:read albums:write'

const REDIRECT_URI = 'http://127.0.0.1:1234/callback'

const json = (body: unknown) =>
  new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } })

type Stub = { fetch: FetchLike; urls: string[]; registration: () => Record<string, unknown> }

const stubServer = (): Stub => {
  const urls: string[] = []
  let registration: Record<string, unknown> | undefined

  const fetch: FetchLike = async (input, init) => {
    const url = typeof input === 'string' ? input : input.toString()
    urls.push(url)

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
      registration = JSON.parse(String(init?.body)) as Record<string, unknown>
      return json({ client_id: 'CLIENT' })
    }
    throw new Error(`unexpected request: ${url}`)
  }

  return {
    fetch,
    urls,
    registration: () => {
      if (!registration) throw new Error('nothing registered')
      return registration
    },
  }
}

const begin = (stub: Stub) =>
  beginBridgeAuthorization(new OAuthClient(SERVER, stub.fetch), REDIRECT_URI)

describe('starting the bridge’s authorization', () => {
  test('binds the token to /mcp rather than the whole server', async () => {
    const { pending } = await begin(stubServer())

    expect(new URL(pending.authorizationUrl).searchParams.get('resource')).toBe(
      PUBLISHED_MCP_RESOURCE,
    )
  })

  test('reads the identifier from the document instead of building it', async () => {
    const stub = stubServer()

    const { pending } = await begin(stub)

    expect(stub.urls).toContain(`${SERVER}/.well-known/oauth-protected-resource/mcp`)
    // Not `${SERVER}/mcp`, which is what concatenation would have produced.
    expect(pending.resource).toBe(PUBLISHED_MCP_RESOURCE)
  })

  test('asks for the same scopes it always did', async () => {
    const stub = stubServer()

    const { pending } = await begin(stub)

    // `resource` is passed positionally, one slot past `scopes`. Getting that wrong is
    // silent: the flow still completes, having asked for a scope named after a URL.
    expect(new URL(pending.authorizationUrl).searchParams.get('scope')).toBe(DEFAULT_SCOPES)
    expect(stub.registration().scope).toBe(DEFAULT_SCOPES)
  })

  test('registers the loopback redirect the listener is actually on', async () => {
    const stub = stubServer()

    const { clientId } = await begin(stub)

    expect(stub.registration().redirect_uris).toEqual([REDIRECT_URI])
    expect(clientId).toBe('CLIENT')
  })
})
