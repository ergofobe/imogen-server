import type { OAuthClient, PendingAuthorization } from '@imogen/sdk'

/**
 * Registers this machine and starts an authorization bound to `/mcp` alone.
 *
 * The bridge forwards to `/mcp` and nowhere else, so an unbound token — valid there *and*
 * across the whole REST API — is more reach than it has any use for. Audiences have been
 * enforced since #14 (merged as #18), which left this server's own stdio bridge as the
 * first-party client still holding the broadest possible token.
 *
 * Read the identifier from the RFC 9728 document rather than building `${baseUrl}/mcp`:
 * the server compares against the one spelling it publishes and normalises nothing beyond
 * trailing slashes, so a concatenated near-miss (`https://Host:443/mcp`) is refused as
 * `invalid_target` by the very server that published the real one.
 *
 * `resource` rides on `pending` from here, which is what stops the authorization request
 * and the token exchange from naming different things — the exchange refuses a resource
 * the code did not record.
 */
export async function beginBridgeAuthorization(
  oauth: OAuthClient,
  redirectUri: string,
): Promise<{ clientId: string; pending: PendingAuthorization }> {
  const client = await oauth.register('imogen CLI', [redirectUri])
  const mcp = await oauth.discoverProtectedResource('/mcp')
  const pending = await oauth.beginAuthorization(
    client.client_id,
    redirectUri,
    undefined,
    mcp.resource,
  )
  return { clientId: client.client_id, pending }
}
