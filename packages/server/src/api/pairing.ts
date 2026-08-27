import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi'
import { PairingClaim, PairingClaimRequest, PairingStatus, PairingTicket } from '@imogen/shared'
import { type AppEnv, requireAuth } from '../auth/middleware.ts'
import { OAuthError } from '../auth/oauth.ts'
import { badRequest, notFound } from '../lib/errors.ts'

/**
 * Pairing a device.
 *
 * Two of these three routes need a browser session and one needs nothing at all, which
 * is the whole design: the browser, already signed in and already knowing the address,
 * makes a ticket; the device, knowing neither, spends it.
 */
export function createPairingRoutes() {
  const app = new OpenAPIHono<AppEnv>()

  /**
   * Claiming comes first, and deliberately outside the authentication middleware below:
   * a device with a ticket has nothing else to authenticate with yet. Hono runs
   * middleware in registration order, so a route registered after `use('*')` would be
   * behind it.
   */
  app.openapi(
    createRoute({
      method: 'post',
      path: '/claim',
      tags: ['Pairing'],
      summary: 'Redeem a pairing code for an authorization code',
      description:
        'Called by a device that has just read a QR code. The authorization code that ' +
        'comes back is exchanged at /oauth/token with the PKCE verifier the device ' +
        'generated, so this response grants nothing on its own.',
      request: { body: { content: { 'application/json': { schema: PairingClaimRequest } } } },
      responses: {
        200: {
          description: 'An authorization code',
          content: { 'application/json': { schema: PairingClaim } },
        },
        400: {
          description: 'The pairing code is unknown, spent, or expired',
          content: {
            'application/json': {
              schema: z.object({ error: z.object({ code: z.string(), message: z.string() }) }),
            },
          },
        },
      },
    }),
    async (c) => {
      const services = c.get('services')
      try {
        return c.json(await services.pairing.claim(c.req.valid('json')), 200)
      } catch (error) {
        // The OAuth layer speaks RFC 6749; this endpoint speaks the imogen envelope,
        // because it is an imogen API route and its callers have one error handler.
        if (error instanceof OAuthError) throw badRequest(error.toJSON().error_description)
        throw error
      }
    },
  )

  const authed = new OpenAPIHono<AppEnv>()
  authed.use('*', requireAuth())

  authed.openapi(
    createRoute({
      method: 'post',
      path: '/',
      tags: ['Pairing'],
      summary: 'Make a pairing ticket for a device to read',
      description:
        'The code is legible only in this response; the server keeps a hash. It is ' +
        'single-use and short-lived, and it carries the server URL so the device never ' +
        'has to be told where to look.',
      security: [{ sessionCookie: [] }],
      responses: {
        201: {
          description: 'A new ticket',
          content: { 'application/json': { schema: PairingTicket } },
        },
      },
    }),
    async (c) => {
      const services = c.get('services')
      const principal = c.get('principal')
      // A bearer token must not be able to mint a fresh grant for something else: that
      // would turn one paired device into an unbounded supply of them.
      if (principal.via !== 'session') {
        throw badRequest('Pairing tickets can only be made from a signed-in browser')
      }
      return c.json(await services.pairing.create(principal.user.id), 201)
    },
  )

  authed.openapi(
    createRoute({
      method: 'get',
      path: '/{ticketId}',
      tags: ['Pairing'],
      summary: 'Whether a ticket has been claimed yet',
      security: [{ sessionCookie: [] }],
      request: { params: z.object({ ticketId: z.uuid() }) },
      responses: {
        200: {
          description: 'The ticket',
          content: { 'application/json': { schema: PairingStatus } },
        },
        404: { description: 'No such ticket' },
      },
    }),
    async (c) => {
      const services = c.get('services')
      const principal = c.get('principal')
      const status = await services.pairing.status(principal.user.id, c.req.valid('param').ticketId)
      if (!status) throw notFound('No such pairing ticket')
      return c.json(status, 200)
    },
  )

  app.route('/', authed)
  return app
}
