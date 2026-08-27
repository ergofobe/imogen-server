import {
  PAIRING_TTL_SECONDS,
  PAIRING_URI_SCHEME,
  type PairingClaim,
  type PairingClaimRequest,
  type PairingStatus,
  type PairingTicket,
} from '@imogen/shared'
import { and, eq, isNull, lt } from 'drizzle-orm'
import type { Database } from '../db/index.ts'
import { pairingTickets } from '../db/schema.ts'
import { generateToken, hashToken } from '../lib/tokens.ts'
import { OAuthError, type OAuthService } from './oauth.ts'

/**
 * What a paired device is given. Everything the phone applications need and nothing
 * more: an administrator's tools stay behind a session, so a stolen device is not a
 * stolen server.
 */
const PAIRED_SCOPES = ['library:read', 'library:write', 'albums:read', 'albums:write', 'profile']

export class PairingService {
  constructor(
    private readonly db: Database,
    private readonly oauth: OAuthService,
    private readonly options: { publicUrl: string },
  ) {}

  /** Issues a ticket for a signed-in person. The code is legible only in this return. */
  async create(userId: string): Promise<PairingTicket> {
    // Nothing else sweeps these, and they are small; clearing the dead ones as we go
    // keeps the table from becoming a log of every phone anybody ever set up.
    await this.db.delete(pairingTickets).where(lt(pairingTickets.expiresAt, new Date()))

    const code = generateToken('imog_pair', 32)
    const expiresAt = new Date(Date.now() + PAIRING_TTL_SECONDS * 1000)
    const [row] = await this.db
      .insert(pairingTickets)
      .values({ userId, codeHash: hashToken(code), expiresAt })
      .returning()
    if (!row) throw new Error('could not create a pairing ticket')

    const serverUrl = this.options.publicUrl
    return {
      id: row.id,
      code,
      serverUrl,
      // Query parameters rather than a fragment: a fragment never leaves the browser,
      // and this string has to survive being turned into pixels and read by a camera.
      uri: `${PAIRING_URI_SCHEME}://pair?server=${encodeURIComponent(serverUrl)}&code=${encodeURIComponent(code)}`,
      expiresAt: expiresAt.toISOString(),
    }
  }

  /** The state of one of your own tickets. Someone else's is not found rather than refused. */
  async status(userId: string, ticketId: string): Promise<PairingStatus | null> {
    const [row] = await this.db
      .select()
      .from(pairingTickets)
      .where(and(eq(pairingTickets.id, ticketId), eq(pairingTickets.userId, userId)))
      .limit(1)
    if (!row) return null
    return {
      id: row.id,
      expiresAt: row.expiresAt.toISOString(),
      claimedAt: row.claimedAt?.toISOString() ?? null,
      deviceName: row.deviceName,
    }
  }

  /**
   * Redeems a ticket for an authorization code.
   *
   * The code that comes back is an ordinary one: it is bound to the device's PKCE
   * challenge and to the client it registered, and it is worth nothing without the
   * verifier. That is deliberate — it means a paired device holds exactly the same kind
   * of grant as one that went through the browser, and is revoked in exactly the same
   * place.
   */
  async claim(request: PairingClaimRequest): Promise<PairingClaim> {
    const [ticket] = await this.db
      .select()
      .from(pairingTickets)
      .where(eq(pairingTickets.codeHash, hashToken(request.code)))
      .limit(1)

    // One message for every way a ticket can be unusable. Distinguishing "expired" from
    // "never existed" tells someone guessing codes that they guessed a real one.
    const refuse = () => new OAuthError('invalid_grant', 'that pairing code is not usable')
    if (!ticket) throw refuse()
    if (ticket.claimedAt) throw refuse()
    if (ticket.expiresAt.getTime() <= Date.now()) throw refuse()

    // Claim before minting, so two devices racing on one photographed code cannot both win.
    const claimed = await this.db
      .update(pairingTickets)
      .set({ claimedAt: new Date(), deviceName: request.deviceName ?? null })
      .where(and(eq(pairingTickets.id, ticket.id), isNull(pairingTickets.claimedAt)))
      .returning()
    if (claimed.length === 0) throw refuse()

    const requested = request.scope?.split(/\s+/).filter(Boolean)
    const scopes =
      requested && requested.length > 0
        ? requested.filter((scope: string) => PAIRED_SCOPES.includes(scope))
        : PAIRED_SCOPES

    const code = await this.oauth.issueAuthorizationCode({
      clientId: request.clientId,
      userId: ticket.userId,
      redirectUri: request.redirectUri,
      scopes: scopes.length > 0 ? scopes : PAIRED_SCOPES,
      codeChallenge: request.codeChallenge,
      codeChallengeMethod: request.codeChallengeMethod,
    })

    return { code, redirectUri: request.redirectUri, scope: scopes.join(' ') }
  }
}
