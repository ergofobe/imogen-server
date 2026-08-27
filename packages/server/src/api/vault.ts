import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi'
import { Asset, AssetSelection, pageOf } from '@imogen/shared'
import type { Context } from 'hono'
import { deleteCookie, getCookie, setCookie } from 'hono/cookie'
import { type AppEnv, requireAuth } from '../auth/middleware.ts'
import { FACE_DETECT_JOB } from '../jobs/faces.ts'
import { forbidden } from '../lib/errors.ts'
import type { Services } from '../services.ts'
import { asHttpError } from '../vault/vault.ts'
import { ERROR_RESPONSES, NO_CONTENT, ok, security } from './openapi.ts'

export const VAULT_COOKIE = 'imogen_vault'

const Passphrase = z.object({ passphrase: z.string().min(8).max(1024) })

const VaultStatus = z.object({
  configured: z.boolean(),
  unlocked: z.boolean(),
  /** Only present while unlocked: a locked vault does not reveal its size. */
  count: z.number().int().nonnegative().optional(),
})

/**
 * Reading the unlock proof. A vault is only ever open for the browser session that
 * unlocked it — an API token or an MCP connector can hold a valid bearer token and still
 * have no way in, which is the point of calling this re-authentication.
 */
export function vaultIsOpen(c: Context<AppEnv>): boolean {
  const principal = c.get('principal')
  if (principal?.via !== 'session' || !principal.sessionId) return false
  const services = c.get('services')
  return services.vault.verify(getCookie(c, VAULT_COOKIE), principal.user.id, principal.sessionId)
}

function requireSession(c: Context<AppEnv>) {
  const principal = c.get('principal')
  if (principal.via !== 'session' || !principal.sessionId) {
    throw forbidden('The vault can only be opened from a signed-in browser session')
  }
  return principal
}

export function createVaultRoutes() {
  const app = new OpenAPIHono<AppEnv>()
  app.use('*', requireAuth())

  app.openapi(
    createRoute({
      method: 'get',
      path: '/status',
      tags: ['Vault'],
      summary: 'Whether the vault is set up, and whether this session has it open',
      security: security(),
      responses: { ...ok(VaultStatus, 'Vault status'), ...ERROR_RESPONSES },
    }),
    async (c) => {
      const services = c.get('services')
      const principal = c.get('principal')
      const configured = await services.vault.isConfigured(principal.user.id)
      const unlocked = vaultIsOpen(c)
      return c.json(
        {
          configured,
          unlocked,
          ...(unlocked ? { count: await services.vault.count(principal.user.id) } : {}),
        },
        200,
      )
    },
  )

  app.openapi(
    createRoute({
      method: 'post',
      path: '/setup',
      tags: ['Vault'],
      summary: 'Choose the vault passphrase',
      description:
        'Deliberately separate from the account password: single sign-on accounts have ' +
        'no local password, and an already signed-in session should not be enough.',
      security: security(),
      request: { body: { content: { 'application/json': { schema: Passphrase } } } },
      responses: { ...NO_CONTENT, ...ERROR_RESPONSES },
    }),
    async (c) => {
      const services = c.get('services')
      const principal = requireSession(c)
      // Changing an existing passphrase requires the vault to be open already.
      if ((await services.vault.isConfigured(principal.user.id)) && !vaultIsOpen(c)) {
        throw forbidden('Unlock the vault before changing its passphrase')
      }
      try {
        await services.vault.setPassphrase(principal.user.id, c.req.valid('json').passphrase)
      } catch (error) {
        throw asHttpError(error)
      }
      return c.body(null, 204)
    },
  )

  app.openapi(
    createRoute({
      method: 'post',
      path: '/unlock',
      tags: ['Vault'],
      summary: 'Open the vault for this session',
      security: security(),
      request: { body: { content: { 'application/json': { schema: Passphrase } } } },
      responses: { ...NO_CONTENT, ...ERROR_RESPONSES },
    }),
    async (c) => {
      const services = c.get('services')
      const principal = requireSession(c)
      let token: string
      try {
        token = await services.vault.unlock(
          principal.user.id,
          c.req.valid('json').passphrase,
          principal.sessionId!,
        )
      } catch (error) {
        throw asHttpError(error)
      }

      setCookie(c, VAULT_COOKIE, token, {
        httpOnly: true,
        secure: services.config.publicUrl.startsWith('https://'),
        sameSite: 'Strict',
        path: '/api/v1',
        maxAge: 15 * 60,
      })
      return c.body(null, 204)
    },
  )

  app.openapi(
    createRoute({
      method: 'post',
      path: '/lock',
      tags: ['Vault'],
      summary: 'Close the vault again',
      security: security(),
      responses: { ...NO_CONTENT, ...ERROR_RESPONSES },
    }),
    async (c) => {
      deleteCookie(c, VAULT_COOKIE, { path: '/api/v1' })
      return c.body(null, 204)
    },
  )

  // --- Everything past here needs the vault actually open ---

  app.use('/assets', async (c, next) => {
    if (!vaultIsOpen(c)) throw forbidden('The vault is locked')
    await next()
  })

  app.openapi(
    createRoute({
      method: 'get',
      path: '/assets',
      tags: ['Vault'],
      summary: 'What is in the vault',
      security: security(),
      request: { query: z.object({ limit: z.coerce.number().int().min(1).max(500).default(200) }) },
      responses: { ...ok(pageOf(Asset), 'Assets in the vault'), ...ERROR_RESPONSES },
    }),
    async (c) => {
      const services = c.get('services')
      const page = await services.vault.list(c.get('principal').user.id, {
        limit: c.req.valid('query').limit,
        sort: 'capturedAt',
        order: 'desc',
      })
      return c.json({ items: page.items, nextCursor: null, total: null }, 200)
    },
  )

  app.openapi(
    createRoute({
      method: 'post',
      path: '/assets',
      tags: ['Vault'],
      summary: 'Move photos into the vault',
      description: 'They leave every album on the way in, since an album can be shared.',
      security: security(),
      request: { body: { content: { 'application/json': { schema: AssetSelection } } } },
      responses: {
        ...ok(z.object({ moved: z.number().int().nonnegative() }), 'How many moved'),
        ...ERROR_RESPONSES,
      },
    }),
    async (c) => {
      const services = c.get('services')
      const ownerId = c.get('principal').user.id
      const assetIds = await services.assets.resolveSelection(ownerId, c.req.valid('json'))
      const moved = await services.vault.moveIn(ownerId, assetIds)

      // Faces found in a vaulted photo stop existing. Leaving them would let a vaulted
      // photo keep contributing to a named person's thumbnail and count. One call, not
      // one per photo — a selection can run to tens of thousands.
      await services.faces.forgetAssets(assetIds, ownerId)
      return c.json({ moved }, 200)
    },
  )

  app.openapi(
    createRoute({
      method: 'delete',
      path: '/assets',
      tags: ['Vault'],
      summary: 'Move photos back into the library',
      security: security(),
      request: { body: { content: { 'application/json': { schema: AssetSelection } } } },
      responses: {
        ...ok(z.object({ moved: z.number().int().nonnegative() }), 'How many moved back'),
        ...ERROR_RESPONSES,
      },
    }),
    async (c) => {
      const services = c.get('services')
      const ownerId = c.get('principal').user.id
      const assetIds = await services.assets.resolveSelection(ownerId, c.req.valid('json'))
      const moved = await services.vault.moveOut(ownerId, assetIds)

      // Out of the vault, a photo rejoins the library and is scanned again.
      if (await services.faces.isEnabled()) {
        for (const assetId of assetIds) {
          await services.queue.enqueue(FACE_DETECT_JOB, { assetId })
        }
      }
      return c.json({ moved }, 200)
    },
  )

  return app
}

/** Used by the asset file routes: a vaulted asset's bytes need the vault open too. */
export async function assertVaultAccess(
  services: Services,
  c: Context<AppEnv>,
  assetId: string,
): Promise<void> {
  if (!(await services.vault.isVaulted(assetId))) return
  if (!vaultIsOpen(c)) throw forbidden('That photo is in the vault')
}
