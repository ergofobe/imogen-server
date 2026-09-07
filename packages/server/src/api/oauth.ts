import {
  ALL_SCOPES,
  ClientRegistrationRequest,
  type OAuthScope,
  SCOPE_DESCRIPTIONS,
} from '@imogen/shared'
import type { Context } from 'hono'
import { Hono } from 'hono'
import { getCookie } from 'hono/cookie'
import type { AppEnv } from '../auth/middleware.ts'
import { resolvePrincipal } from '../auth/middleware.ts'
import { OAuthError } from '../auth/oauth.ts'
import { SESSION_COOKIE } from '../auth/sessions.ts'
import { renderConsent } from './consent.ts'

/**
 * The OAuth 2.1 surface. Claude.ai and Grok connectors discover this server through the
 * two well-known documents, register themselves through RFC 7591, and then run a normal
 * authorization-code-with-PKCE flow. No API key is ever pasted anywhere.
 */
export function createOAuthRoutes() {
  const app = new Hono<AppEnv>()

  app.get('/authorize', async (c) => {
    const services = c.get('services')
    const query = c.req.query()

    const clientId = query.client_id
    const redirectUri = query.redirect_uri
    if (!clientId || !redirectUri) {
      return c.text('client_id and redirect_uri are required', 400)
    }

    const client = await services.oauth.getClient(clientId)
    if (!client) return c.text('Unknown client', 400)
    // Never redirect to an unregistered URI: that is how an authorization code is stolen.
    if (!client.redirectUris.includes(redirectUri)) {
      return c.text('redirect_uri is not registered for this client', 400)
    }

    const state = query.state ?? ''
    const fail = (error: string, description: string) => {
      const url = new URL(redirectUri)
      url.searchParams.set('error', error)
      url.searchParams.set('error_description', description)
      if (state) url.searchParams.set('state', state)
      return c.redirect(url.toString())
    }

    if (query.response_type !== 'code') {
      return fail('unsupported_response_type', 'Only the authorization code flow is supported')
    }
    if (!query.code_challenge || query.code_challenge_method !== 'S256') {
      return fail('invalid_request', 'PKCE with S256 is required')
    }

    // The user must be signed in to consent. Send them to sign in and come back.
    // Only a session may consent, so no bearer token is ever honoured here and there is
    // no resource to check one against.
    const principal = await resolvePrincipal(
      services,
      c.req.raw.headers,
      getCookie(c, SESSION_COOKIE),
      null,
    )
    if (principal?.via !== 'session') {
      const returnTo = `/oauth/authorize?${new URLSearchParams(query).toString()}`
      return c.redirect(`/login?returnTo=${encodeURIComponent(returnTo)}`)
    }

    // RFC 8707. Settled before the consent screen so the user is never asked to approve a
    // request that cannot be honoured. imogen binds a token to a single resource, so a
    // request naming several distinct ones has no answer.
    let resource: string | undefined
    try {
      const named = new Set(
        (c.req.queries('resource') ?? []).map((value) => services.oauth.canonicalResource(value)),
      )
      if (named.size > 1) {
        return fail('invalid_target', 'a token may be bound to only one resource')
      }
      resource = [...named][0]
    } catch (error) {
      if (error instanceof OAuthError) return fail(error.code, error.toJSON().error_description)
      throw error
    }

    const scopeList = query.scope?.split(/\s+/).filter(Boolean)
    const requested = (scopeList ?? ['library:read']).filter((s): s is OAuthScope =>
      (ALL_SCOPES as string[]).includes(s),
    )
    const scopes = requested.length > 0 ? requested : (['library:read'] as OAuthScope[])

    if (c.req.query('approved') === undefined) {
      return c.html(
        renderConsent({
          clientName: client.name,
          clientUri: client.clientUri,
          userName: principal.user.name,
          userEmail: principal.user.email,
          scopes: scopes.map((s) => ({ scope: s, description: SCOPE_DESCRIPTIONS[s] })),
          query,
        }),
      )
    }

    if (c.req.query('approved') !== 'yes') {
      return fail('access_denied', 'The user declined the request')
    }

    try {
      const code = await services.oauth.issueAuthorizationCode({
        clientId,
        userId: principal.user.id,
        redirectUri,
        scopes,
        codeChallenge: query.code_challenge,
        codeChallengeMethod: query.code_challenge_method,
        resource,
      })
      const url = new URL(redirectUri)
      url.searchParams.set('code', code)
      if (state) url.searchParams.set('state', state)
      return c.redirect(url.toString())
    } catch (error) {
      if (error instanceof OAuthError) return fail(error.code, error.message)
      throw error
    }
  })

  app.post('/token', async (c) => {
    const services = c.get('services')
    const form = await c.req.parseBody()
    const field = (name: string) => {
      const value = form[name]
      return typeof value === 'string' ? value : undefined
    }

    // Credentials may arrive in the body or as HTTP Basic, per RFC 6749 §2.3.1.
    let clientId = field('client_id')
    let clientSecret = field('client_secret')
    const authorization = c.req.header('authorization')
    if (authorization?.toLowerCase().startsWith('basic ')) {
      const decoded = Buffer.from(authorization.slice(6), 'base64').toString()
      const separator = decoded.indexOf(':')
      if (separator > 0) {
        clientId ??= decodeURIComponent(decoded.slice(0, separator))
        clientSecret ??= decodeURIComponent(decoded.slice(separator + 1))
      }
    }

    if (!clientId) return oauthError(c, 'invalid_request', 'client_id is required')

    try {
      const grantType = field('grant_type')
      if (grantType === 'authorization_code') {
        const code = field('code')
        const codeVerifier = field('code_verifier')
        const redirectUri = field('redirect_uri')
        if (!code || !codeVerifier || !redirectUri) {
          return oauthError(
            c,
            'invalid_request',
            'code, code_verifier, and redirect_uri are required',
          )
        }
        const token = await services.oauth.exchangeAuthorizationCode({
          clientId,
          clientSecret,
          code,
          codeVerifier,
          redirectUri,
          resource: field('resource'),
        })
        return c.json(token, 200, { 'Cache-Control': 'no-store' })
      }

      if (grantType === 'refresh_token') {
        const refreshToken = field('refresh_token')
        if (!refreshToken) return oauthError(c, 'invalid_request', 'refresh_token is required')
        const token = await services.oauth.refresh({
          clientId,
          clientSecret,
          refreshToken,
          scope: field('scope'),
          resource: field('resource'),
        })
        return c.json(token, 200, { 'Cache-Control': 'no-store' })
      }

      return oauthError(c, 'unsupported_grant_type', `Unsupported grant_type: ${grantType}`)
    } catch (error) {
      if (error instanceof OAuthError) {
        return c.json(error.toJSON(), error.status as 400, { 'Cache-Control': 'no-store' })
      }
      throw error
    }
  })

  /** RFC 7591. Connectors register themselves; nobody has to paste a client ID. */
  app.post('/register', async (c) => {
    const services = c.get('services')
    const body = await c.req.json().catch(() => null)
    const parsed = ClientRegistrationRequest.safeParse(body)
    if (!parsed.success) {
      return c.json(
        {
          error: 'invalid_client_metadata',
          error_description: parsed.error.issues
            .map((i) => `${i.path.join('.')}: ${i.message}`)
            .join('; '),
        },
        400,
      )
    }
    try {
      const client = await services.oauth.registerClient(parsed.data)
      return c.json(client, 201, { 'Cache-Control': 'no-store' })
    } catch (error) {
      if (error instanceof OAuthError) return c.json(error.toJSON(), error.status as 400)
      throw error
    }
  })

  app.post('/revoke', async (c) => {
    const services = c.get('services')
    const form = await c.req.parseBody()
    const token = form.token
    if (typeof token === 'string') await services.oauth.revokeToken(token)
    // RFC 7009: always 200, so a caller cannot probe which tokens exist.
    return c.body(null, 200)
  })

  return app
}

function oauthError(c: Context<AppEnv>, error: string, description: string) {
  return c.json({ error, error_description: description }, 400, { 'Cache-Control': 'no-store' })
}

/** The two documents an MCP connector fetches before it knows how to authenticate. */
export function createWellKnownRoutes() {
  const app = new Hono<AppEnv>()

  const cors = { 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'public, max-age=3600' }

  app.get('/oauth-authorization-server', (c) =>
    c.json(c.get('services').oauth.authorizationServerMetadata(), 200, cors),
  )
  app.get('/oauth-protected-resource', (c) =>
    c.json(c.get('services').oauth.protectedResourceMetadata(), 200, cors),
  )
  // RFC 9728 nests the document under the resource's own path, so this one describes the
  // MCP endpoint. It has to name that endpoint, not the site root, or the client that
  // followed the 401 here cannot match the document to what it was refused at.
  app.get('/oauth-protected-resource/mcp', (c) =>
    c.json(c.get('services').oauth.protectedResourceMetadata('/mcp'), 200, cors),
  )
  // Some clients probe the OIDC discovery path first.
  app.get('/openid-configuration', (c) =>
    c.json(c.get('services').oauth.authorizationServerMetadata(), 200, cors),
  )

  return app
}
