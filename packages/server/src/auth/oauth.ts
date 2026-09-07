import {
  ALL_SCOPES,
  type ClientRegistrationRequest,
  type ClientRegistrationResponse,
  type OAuthScope,
  type TokenResponse,
} from '@imogen/shared'
import { and, eq, inArray, isNull } from 'drizzle-orm'
import type { Database } from '../db/index.ts'
import { oauthAuthCodes, oauthClients, oauthTokens } from '../db/schema.ts'
import { generateToken, hashToken, safeEqual, sha256Base64Url } from '../lib/tokens.ts'

const ACCESS_TOKEN_TTL_SECONDS = 60 * 60
const REFRESH_TOKEN_TTL_SECONDS = 60 * 60 * 24 * 60
const AUTH_CODE_TTL_SECONDS = 60

/**
 * The resources this server publishes a protected-resource document for: the site root,
 * which is the REST API, and the MCP endpoint. A token may be bound to one of these and
 * to nothing else.
 */
const PROTECTED_RESOURCE_PATHS = ['', '/mcp'] as const

/** The path of a resource this server publishes a document for, and nothing else. */
export type ProtectedResourcePath = (typeof PROTECTED_RESOURCE_PATHS)[number]

/**
 * The one spelling of a resource identifier this server uses, everywhere.
 *
 * `IMOGEN_PUBLIC_URL` only has its trailing slashes stripped, so it can still arrive as
 * `https://Host:443`. Advertising that spelling while comparing against a normalised one
 * would make the server refuse the very identifier it published, and a spec-compliant MCP
 * client — which must echo `resource` back from the document — could never connect.
 */
function canonicalize(url: URL): string {
  return url.href.replace(/\/+$/, '')
}

/** The OAuth error codes imogen can return, as defined by RFC 6749 §5.2 and RFC 7591. */
export type OAuthErrorCode =
  | 'invalid_request'
  | 'invalid_client'
  | 'invalid_grant'
  | 'invalid_scope'
  | 'unauthorized_client'
  | 'unsupported_grant_type'
  | 'invalid_redirect_uri'
  | 'invalid_client_metadata'
  | 'invalid_target'

export class OAuthError extends Error {
  readonly code: OAuthErrorCode
  readonly status: number

  constructor(code: OAuthErrorCode, description: string, status = 400) {
    super(`${code}: ${description}`)
    this.name = 'OAuthError'
    this.code = code
    this.status = status
  }

  toJSON() {
    return { error: this.code, error_description: this.message.slice(this.code.length + 2) }
  }
}

export type Principal = {
  userId: string
  clientId: string
  scopes: OAuthScope[]
  /** The resource this token is bound to, or null when it is valid at every surface. */
  resource: string | null
}

export type IssueCodeInput = {
  clientId: string
  userId: string
  redirectUri: string
  scopes: string[]
  codeChallenge: string
  codeChallengeMethod: string
  /** RFC 8707 `resource`. Must be one of the identifiers this server advertises. */
  resource?: string
  ttlSeconds?: number
}

export type ExchangeInput = {
  clientId: string
  clientSecret?: string
  code: string
  codeVerifier: string
  redirectUri: string
  resource?: string
}

export type RefreshInput = {
  clientId: string
  clientSecret?: string
  refreshToken: string
  scope?: string
  resource?: string
}

/**
 * A redirect URI is acceptable if it is https, a loopback http address (which native
 * apps need for the system browser flow), or any private-use scheme such as
 * `myapp://oauth` (RFC 8252). Plain http to a remote host is not, because the
 * authorization code would travel in the clear.
 */
function assertValidRedirectUri(uri: string): void {
  let parsed: URL
  try {
    parsed = new URL(uri)
  } catch {
    throw new OAuthError('invalid_redirect_uri', `${uri} is not a valid URI`)
  }
  if (parsed.hash) {
    throw new OAuthError('invalid_redirect_uri', 'redirect URIs must not contain a fragment')
  }
  if (parsed.protocol === 'https:') return
  if (parsed.protocol === 'http:') {
    const loopback = ['localhost', '127.0.0.1', '[::1]', '::1']
    if (loopback.includes(parsed.hostname)) return
    throw new OAuthError('invalid_redirect_uri', 'http redirect URIs must target loopback')
  }
  // Everything else is a private-use scheme the operating system routes back to the app.
  return
}

function narrowScopes(requested: string | string[] | undefined): OAuthScope[] {
  const list = typeof requested === 'string' ? requested.split(/\s+/) : (requested ?? [])
  const granted = list.filter((s): s is OAuthScope => (ALL_SCOPES as string[]).includes(s))
  return granted.length > 0 ? [...new Set(granted)] : ['library:read']
}

export class OAuthService {
  constructor(
    private readonly db: Database,
    private readonly options: { publicUrl: string },
  ) {}

  // --- Metadata ---

  authorizationServerMetadata() {
    const base = this.options.publicUrl
    return {
      issuer: base,
      authorization_endpoint: `${base}/oauth/authorize`,
      token_endpoint: `${base}/oauth/token`,
      registration_endpoint: `${base}/oauth/register`,
      revocation_endpoint: `${base}/oauth/revoke`,
      scopes_supported: [...ALL_SCOPES],
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      // S256 only. Advertising `plain` invites a downgrade that defeats the point.
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none', 'client_secret_post', 'client_secret_basic'],
      // Conventional rather than registered: RFC 8707 defines the `resource` parameter
      // and the `invalid_target` error but no metadata field for them, and RFC 8414 §2
      // allows the extra key. Advertised only because `resource` is now recorded and
      // enforced; a client that sends it gets a token that works nowhere else.
      resource_indicators_supported: true,
      service_documentation: `${base}/api/v1/docs`,
    }
  }

  /**
   * RFC 9728: `resource` is the identifier of the resource the client asked about, which
   * for an MCP connector is the endpoint URL rather than the site root. Answering with the
   * root from `/.well-known/oauth-protected-resource/mcp` reads as a mismatched document,
   * and a connect-card client that cannot match it never builds an authorization URL.
   */
  protectedResourceMetadata(resourcePath: ProtectedResourcePath = '') {
    const base = this.options.publicUrl
    return {
      resource: this.resourceIdentifier(resourcePath),
      authorization_servers: [base],
      scopes_supported: [...ALL_SCOPES],
      bearer_methods_supported: ['header'],
      resource_documentation: `${base}/api/v1/docs`,
    }
  }

  /**
   * The identifier of one resource this server protects, in the single spelling that the
   * document publishes, the token records, and the surface checks against. Callers ask
   * for it rather than building it, because three concatenations of `publicUrl` would
   * eventually disagree and the disagreement would read as a valid token being refused.
   */
  resourceIdentifier(path: ProtectedResourcePath = ''): string {
    return canonicalize(new URL(`${this.options.publicUrl}${path}`))
  }

  /** Every identifier a token may name. */
  resourceIdentifiers(): string[] {
    return PROTECTED_RESOURCE_PATHS.map((path) => this.resourceIdentifier(path))
  }

  /**
   * Resolves an RFC 8707 `resource` to the identifier this server advertises, or refuses.
   *
   * The comparison is against the advertised set after URL normalisation rather than by
   * inspecting the path, which is what stops `https://host/mcp/../anything` — normalised
   * by `URL` to `/anything` — from being read as the MCP endpoint. A trailing slash names
   * the same resource; a query, a fragment, or another origin does not.
   */
  canonicalResource(value: string): string {
    let parsed: URL
    try {
      parsed = new URL(value)
    } catch {
      throw new OAuthError('invalid_target', `${value} is not a valid resource identifier`)
    }
    if (parsed.hash) {
      throw new OAuthError('invalid_target', 'a resource identifier must not contain a fragment')
    }
    const normalized = canonicalize(parsed)
    const match = this.resourceIdentifiers().find((identifier) => identifier === normalized)
    if (!match) {
      throw new OAuthError('invalid_target', `${value} is not a resource of this server`)
    }
    return match
  }

  // --- Registration ---

  async registerClient(request: ClientRegistrationRequest): Promise<ClientRegistrationResponse> {
    if (request.redirect_uris.length === 0) {
      throw new OAuthError('invalid_client_metadata', 'at least one redirect URI is required')
    }
    for (const uri of request.redirect_uris) assertValidRedirectUri(uri)

    const authMethod = request.token_endpoint_auth_method ?? 'none'
    const scopes = narrowScopes(request.scope)
    const clientId = generateToken('imog_client', 16)
    const secret = authMethod === 'none' ? undefined : generateToken('imog_secret', 32)
    const grantTypes = ['authorization_code', 'refresh_token']

    await this.db.insert(oauthClients).values({
      id: clientId,
      secretHash: secret ? hashToken(secret) : null,
      name: request.client_name ?? 'Unnamed client',
      redirectUris: request.redirect_uris,
      grantTypes,
      scopes,
      tokenEndpointAuthMethod: authMethod,
      clientUri: request.client_uri ?? null,
      logoUri: request.logo_uri ?? null,
      dynamicallyRegistered: true,
    })

    return {
      client_id: clientId,
      ...(secret ? { client_secret: secret } : {}),
      client_id_issued_at: Math.floor(Date.now() / 1000),
      // 0 means "does not expire" per RFC 7591.
      client_secret_expires_at: 0,
      client_name: request.client_name,
      redirect_uris: request.redirect_uris,
      grant_types: grantTypes,
      response_types: ['code'],
      token_endpoint_auth_method: authMethod,
      scope: scopes.join(' '),
    }
  }

  async getClient(clientId: string) {
    const [client] = await this.db
      .select()
      .from(oauthClients)
      .where(eq(oauthClients.id, clientId))
      .limit(1)
    return client ?? null
  }

  private async authenticateClient(clientId: string, clientSecret: string | undefined) {
    const client = await this.getClient(clientId)
    if (!client) throw new OAuthError('invalid_client', 'unknown client', 401)
    if (client.secretHash) {
      if (!clientSecret || !safeEqual(hashToken(clientSecret), client.secretHash)) {
        throw new OAuthError('invalid_client', 'client authentication failed', 401)
      }
    }
    return client
  }

  // --- Authorization codes ---

  /**
   * Every way {@link issueAuthorizationCode} refuses an input before it writes anything.
   *
   * Split out because a caller may need to know the answer earlier than the mint gives it.
   * `PairingService.claim` does: it spends a single-use ticket on the way here, and a
   * refusal after that point strands the device instead of asking it to try again. Two
   * callers keeping their own copy of this list is how the copies drift, so this is the
   * one that decides and the mint runs it too.
   *
   * Hands back the canonical spelling of `input.resource`, or null when it named none, so
   * the mint records what was checked rather than resolving it a second time.
   */
  async assertCanIssueAuthorizationCode(input: IssueCodeInput): Promise<string | null> {
    if (input.codeChallengeMethod !== 'S256') {
      throw new OAuthError('invalid_request', 'code_challenge_method must be S256')
    }
    if (!input.codeChallenge) {
      throw new OAuthError('invalid_request', 'code_challenge is required')
    }
    const client = await this.getClient(input.clientId)
    if (!client) throw new OAuthError('invalid_client', 'unknown client', 401)
    if (!client.redirectUris.includes(input.redirectUri)) {
      throw new OAuthError('invalid_redirect_uri', 'redirect_uri is not registered')
    }
    return input.resource === undefined ? null : this.canonicalResource(input.resource)
  }

  async issueAuthorizationCode(input: IssueCodeInput): Promise<string> {
    const resource = await this.assertCanIssueAuthorizationCode(input)

    const code = generateToken('imog_code', 32)
    const ttl = input.ttlSeconds ?? AUTH_CODE_TTL_SECONDS
    await this.db.insert(oauthAuthCodes).values({
      codeHash: hashToken(code),
      clientId: input.clientId,
      userId: input.userId,
      redirectUri: input.redirectUri,
      scopes: narrowScopes(input.scopes),
      codeChallenge: input.codeChallenge,
      codeChallengeMethod: input.codeChallengeMethod,
      resource,
      familyId: crypto.randomUUID(),
      expiresAt: new Date(Date.now() + ttl * 1000),
    })
    return code
  }

  async exchangeAuthorizationCode(input: ExchangeInput): Promise<TokenResponse> {
    await this.authenticateClient(input.clientId, input.clientSecret)

    const [record] = await this.db
      .select()
      .from(oauthAuthCodes)
      .where(eq(oauthAuthCodes.codeHash, hashToken(input.code)))
      .limit(1)

    if (!record) throw new OAuthError('invalid_grant', 'unknown authorization code')

    // A second presentation means the code leaked. Kill what it already minted.
    if (record.consumedAt) {
      await this.revokeFamily(record.familyId)
      throw new OAuthError('invalid_grant', 'authorization code has already been used')
    }
    if (record.expiresAt.getTime() <= Date.now()) {
      throw new OAuthError('invalid_grant', 'authorization code has expired')
    }
    if (record.clientId !== input.clientId) {
      throw new OAuthError('invalid_grant', 'authorization code was issued to another client')
    }
    if (record.redirectUri !== input.redirectUri) {
      throw new OAuthError('invalid_grant', 'redirect_uri does not match the authorization request')
    }
    if (!safeEqual(sha256Base64Url(input.codeVerifier), record.codeChallenge)) {
      throw new OAuthError('invalid_grant', 'code_verifier does not match the challenge')
    }
    // RFC 8707 §2.2: the token request may name a resource, but only one the user
    // actually authorized. A code issued without one cannot acquire an audience here.
    if (input.resource !== undefined) {
      if (this.canonicalResource(input.resource) !== record.resource) {
        throw new OAuthError('invalid_target', 'resource does not match the authorization request')
      }
    }

    // Claim the code before minting anything, so two concurrent exchanges cannot both win.
    const claimed = await this.db
      .update(oauthAuthCodes)
      .set({ consumedAt: new Date() })
      .where(and(eq(oauthAuthCodes.codeHash, record.codeHash), isNull(oauthAuthCodes.consumedAt)))
      .returning()
    if (claimed.length === 0) {
      await this.revokeFamily(record.familyId)
      throw new OAuthError('invalid_grant', 'authorization code has already been used')
    }

    return this.mintTokenPair({
      clientId: record.clientId,
      userId: record.userId,
      scopes: record.scopes as OAuthScope[],
      familyId: record.familyId,
      resource: record.resource,
    })
  }

  // --- Refresh ---

  async refresh(input: RefreshInput): Promise<TokenResponse> {
    await this.authenticateClient(input.clientId, input.clientSecret)

    const [record] = await this.db
      .select()
      .from(oauthTokens)
      .where(
        and(
          eq(oauthTokens.tokenHash, hashToken(input.refreshToken)),
          eq(oauthTokens.kind, 'refresh'),
        ),
      )
      .limit(1)

    if (!record) throw new OAuthError('invalid_grant', 'unknown refresh token')

    // Presenting a token that was already rotated means someone kept a copy.
    if (record.rotatedAt) {
      await this.revokeFamily(record.familyId)
      throw new OAuthError('invalid_grant', 'refresh token has already been rotated')
    }
    if (record.revokedAt) throw new OAuthError('invalid_grant', 'refresh token was revoked')
    if (record.expiresAt.getTime() <= Date.now()) {
      throw new OAuthError('invalid_grant', 'refresh token has expired')
    }
    if (record.clientId !== input.clientId) {
      throw new OAuthError('invalid_grant', 'refresh token was issued to another client')
    }
    // A refresh may narrow scope but never changes audience: the resource was settled at
    // consent, so asking for a different one here is an attempt to widen the grant.
    if (input.resource !== undefined) {
      if (this.canonicalResource(input.resource) !== record.resource) {
        throw new OAuthError('invalid_target', 'resource does not match the original grant')
      }
    }

    const held = record.scopes as OAuthScope[]
    let scopes = held
    if (input.scope) {
      const requested = input.scope.split(/\s+/).filter(Boolean)
      const widened = requested.filter((s) => !held.includes(s as OAuthScope))
      if (widened.length > 0) {
        throw new OAuthError('invalid_scope', `cannot widen scope to ${widened.join(', ')}`)
      }
      scopes = requested as OAuthScope[]
    }

    await this.db
      .update(oauthTokens)
      .set({ rotatedAt: new Date() })
      .where(eq(oauthTokens.id, record.id))

    return this.mintTokenPair({
      clientId: record.clientId,
      userId: record.userId,
      scopes,
      familyId: record.familyId,
      resource: record.resource,
    })
  }

  // --- Verification and revocation ---

  async verifyAccessToken(token: string): Promise<Principal | null> {
    const [record] = await this.db
      .select()
      .from(oauthTokens)
      .where(and(eq(oauthTokens.tokenHash, hashToken(token)), eq(oauthTokens.kind, 'access')))
      .limit(1)

    if (!record) return null
    if (record.revokedAt) return null
    if (record.expiresAt.getTime() <= Date.now()) return null

    return {
      userId: record.userId,
      clientId: record.clientId,
      scopes: record.scopes as OAuthScope[],
      resource: record.resource,
    }
  }

  async revokeToken(token: string): Promise<void> {
    await this.db
      .update(oauthTokens)
      .set({ revokedAt: new Date() })
      .where(eq(oauthTokens.tokenHash, hashToken(token)))
  }

  /** Revokes every token descended from one authorization — the breach containment step. */
  async revokeFamily(familyId: string): Promise<void> {
    await this.db
      .update(oauthTokens)
      .set({ revokedAt: new Date() })
      .where(eq(oauthTokens.familyId, familyId))
  }

  async revokeGrant(userId: string, clientId: string): Promise<void> {
    const families = await this.db
      .selectDistinct({ familyId: oauthTokens.familyId })
      .from(oauthTokens)
      .where(and(eq(oauthTokens.userId, userId), eq(oauthTokens.clientId, clientId)))
    if (families.length === 0) return
    await this.db
      .update(oauthTokens)
      .set({ revokedAt: new Date() })
      .where(
        inArray(
          oauthTokens.familyId,
          families.map((f) => f.familyId),
        ),
      )
  }

  private async mintTokenPair(grant: {
    clientId: string
    userId: string
    scopes: OAuthScope[]
    familyId: string
    resource: string | null
  }): Promise<TokenResponse> {
    const accessToken = generateToken('imog_at', 32)
    const refreshToken = generateToken('imog_rt', 32)
    const now = Date.now()

    await this.db.insert(oauthTokens).values([
      {
        tokenHash: hashToken(accessToken),
        kind: 'access',
        clientId: grant.clientId,
        userId: grant.userId,
        scopes: grant.scopes,
        familyId: grant.familyId,
        resource: grant.resource,
        expiresAt: new Date(now + ACCESS_TOKEN_TTL_SECONDS * 1000),
      },
      {
        tokenHash: hashToken(refreshToken),
        kind: 'refresh',
        clientId: grant.clientId,
        userId: grant.userId,
        scopes: grant.scopes,
        familyId: grant.familyId,
        resource: grant.resource,
        expiresAt: new Date(now + REFRESH_TOKEN_TTL_SECONDS * 1000),
      },
    ])

    return {
      access_token: accessToken,
      token_type: 'Bearer',
      expires_in: ACCESS_TOKEN_TTL_SECONDS,
      refresh_token: refreshToken,
      scope: grant.scopes.join(' '),
    }
  }
}
