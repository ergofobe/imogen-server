import * as client from 'openid-client'
import type { OidcConfig } from '../lib/config.ts'
import { deriveAccountUrl } from './account-url.ts'
import { AuthError } from './accounts.ts'

export type OidcClaims = {
  subject: string
  email: string
  name: string
  avatarUrl: string | null
  isAdmin: boolean
  /** True when this deployment maps a provider group to administrator at all. */
  adminMappingConfigured: boolean
}

/** Transient state for one in-flight login, held server-side between redirect and callback. */
export type OidcFlow = {
  state: string
  nonce: string
  codeVerifier: string
  returnTo: string
  createdAt: number
}

const FLOW_TTL_MS = 10 * 60 * 1000

/**
 * The callback URL to hand openid-client, rebuilt on the redirect URI this server
 * actually registered.
 *
 * openid-client derives the token request's `redirect_uri` from the URL it is given
 * (`redirectUri = stripParams(currentUrl)`), and the provider checks that it is identical
 * to the one sent at the authorization step. imogen is documented as running behind
 * something that terminates TLS, so the request reaches it as plain http — and the raw
 * request URL is therefore `http://…`, while the authorization step correctly used the
 * public `https://…`. The provider sees two different redirect URIs and rejects the
 * exchange with invalid_grant.
 *
 * Only the query is taken from the incoming request; that is where `code` and `state`
 * live, and it is the only part the raw URL is authoritative about.
 */
export function callbackUrlFor(redirectUri: string, currentUrl: URL): URL {
  const url = new URL(redirectUri)
  url.search = currentUrl.search
  return url
}

/**
 * Generic OIDC through discovery, so Authentik, Keycloak, Auth0, and Google all take the
 * same code path. imogen never special-cases a provider; if it speaks OIDC, it works.
 */
export class OidcService {
  private configuration: client.Configuration | null = null
  private readonly flows = new Map<string, OidcFlow>()

  constructor(
    private readonly settings: OidcConfig,
    private readonly redirectUri: string,
  ) {}

  get label(): string {
    return this.settings.label
  }

  /** Where someone edits the name and email this provider owns. */
  get accountUrl(): string | null {
    return deriveAccountUrl(this.settings.issuer, this.settings.accountUrl)
  }

  private async discover(): Promise<client.Configuration> {
    if (this.configuration) return this.configuration
    this.configuration = await client.discovery(
      new URL(this.settings.issuer),
      this.settings.clientId,
      this.settings.clientSecret,
    )
    return this.configuration
  }

  /** Builds the provider URL to send the browser to, and remembers what to check on return. */
  async startLogin(returnTo = '/'): Promise<string> {
    const config = await this.discover()
    const codeVerifier = client.randomPKCECodeVerifier()
    const codeChallenge = await client.calculatePKCECodeChallenge(codeVerifier)
    const state = client.randomState()
    const nonce = client.randomNonce()

    this.pruneFlows()
    this.flows.set(state, { state, nonce, codeVerifier, returnTo, createdAt: Date.now() })

    return client
      .buildAuthorizationUrl(config, {
        redirect_uri: this.redirectUri,
        scope: this.settings.scopes,
        code_challenge: codeChallenge,
        code_challenge_method: 'S256',
        state,
        nonce,
      })
      .toString()
  }

  async completeLogin(currentUrl: URL): Promise<{ claims: OidcClaims; returnTo: string }> {
    const state = currentUrl.searchParams.get('state')
    const flow = state ? this.flows.get(state) : undefined
    if (!flow)
      throw new AuthError('oidc_state_mismatch', 'Login request expired or was tampered with', 400)
    // One-shot: a replayed callback finds nothing.
    this.flows.delete(state!)

    const config = await this.discover()
    const tokens = await client.authorizationCodeGrant(config, this.callbackUrl(currentUrl), {
      pkceCodeVerifier: flow.codeVerifier,
      expectedState: flow.state,
      expectedNonce: flow.nonce,
    })

    const claims = tokens.claims()
    if (!claims)
      throw new AuthError('oidc_no_claims', 'Identity provider returned no ID token', 502)

    let email = typeof claims.email === 'string' ? claims.email : undefined
    let name = typeof claims.name === 'string' ? claims.name : undefined
    let picture = typeof claims.picture === 'string' ? claims.picture : null
    let groups: unknown = claims[this.settings.adminClaim]

    // Some providers keep email and groups out of the ID token; ask userinfo for them.
    if (!email || groups === undefined) {
      const info = await client
        .fetchUserInfo(config, tokens.access_token, claims.sub)
        .catch(() => null)
      if (info) {
        email ??= typeof info.email === 'string' ? info.email : undefined
        name ??= typeof info.name === 'string' ? info.name : undefined
        picture ??= typeof info.picture === 'string' ? info.picture : null
        groups ??= (info as Record<string, unknown>)[this.settings.adminClaim]
      }
    }

    if (!email) {
      throw new AuthError(
        'oidc_no_email',
        'Identity provider did not supply an email address. Add the "email" scope.',
        502,
      )
    }

    return {
      claims: {
        subject: claims.sub,
        email,
        name: name ?? email.split('@')[0]!,
        avatarUrl: picture,
        isAdmin: this.grantsAdmin(groups),
        adminMappingConfigured: Boolean(this.settings.adminValue),
      },
      returnTo: flow.returnTo,
    }
  }

  /** See callbackUrlFor: the raw request URL is not what the provider agreed to. */
  private callbackUrl(currentUrl: URL): URL {
    return callbackUrlFor(this.redirectUri, currentUrl)
  }

  private grantsAdmin(groups: unknown): boolean {
    const wanted = this.settings.adminValue
    if (!wanted) return false
    if (Array.isArray(groups)) return groups.includes(wanted)
    if (typeof groups === 'string') return groups.split(/[\s,]+/).includes(wanted)
    return false
  }

  private pruneFlows() {
    const cutoff = Date.now() - FLOW_TTL_MS
    for (const [key, flow] of this.flows) {
      if (flow.createdAt < cutoff) this.flows.delete(key)
    }
  }
}
