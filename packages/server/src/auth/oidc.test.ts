import { describe, expect, test } from 'bun:test'
import { callbackUrlFor } from './oidc.ts'

const REDIRECT = 'https://photos.example.com/api/v1/auth/oidc/callback'

describe('callbackUrlFor', () => {
  // Regression: imogen runs behind something that terminates TLS, so the callback
  // arrives as plain http on the internal host. openid-client derives the token
  // request's redirect_uri from the URL it is handed, so passing the raw request URL
  // sent `http://…` to the token endpoint while the authorization step had sent
  // `https://…`. Authentik answered 400 invalid_grant and sign-in was impossible.
  test('uses the registered redirect URI, not the scheme the request arrived on', () => {
    const arrived = new URL('http://imogen.internal/api/v1/auth/oidc/callback?code=abc&state=xyz')
    expect(callbackUrlFor(REDIRECT, arrived).toString()).toBe(`${REDIRECT}?code=abc&state=xyz`)
  })

  test('keeps the query, which is where code and state live', () => {
    const arrived = new URL('http://imogen.internal/whatever?code=abc&state=xyz&extra=1')
    const url = callbackUrlFor(REDIRECT, arrived)
    expect(url.searchParams.get('code')).toBe('abc')
    expect(url.searchParams.get('state')).toBe('xyz')
    expect(url.searchParams.get('extra')).toBe('1')
  })

  test('ignores a path the proxy may have rewritten', () => {
    const arrived = new URL('http://imogen.internal/rewritten/path?code=abc')
    expect(callbackUrlFor(REDIRECT, arrived).pathname).toBe('/api/v1/auth/oidc/callback')
  })

  test('is a no-op when the request already arrived on the public URL', () => {
    const arrived = new URL(`${REDIRECT}?code=abc&state=xyz`)
    expect(callbackUrlFor(REDIRECT, arrived).toString()).toBe(`${REDIRECT}?code=abc&state=xyz`)
  })

  test('carries an error response through unchanged', () => {
    const arrived = new URL('http://imogen.internal/api/v1/auth/oidc/callback?error=access_denied')
    expect(callbackUrlFor(REDIRECT, arrived).searchParams.get('error')).toBe('access_denied')
  })
})
