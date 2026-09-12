import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi'
import {
  AdminClient,
  AdminPasswordReset,
  AdminSession,
  AdminShareLink,
  AdminUser,
  AdminUserList,
  AdminUserUpdate,
  Invite,
  InviteCreate,
  InviteCreated,
  QueueHealth,
  ServerSettings,
  ServerSettingsUpdate,
  StorageReport,
} from '@imogen/shared'
import { type AppEnv, requireHiddenAdmin } from '../auth/middleware.ts'
import { isRepairName, REPAIRS } from '../jobs/repair.ts'
import { notFound } from '../lib/errors.ts'
import { created, ERROR_RESPONSES, NO_CONTENT, ok, security } from './openapi.ts'

const IdParam = z.object({ id: z.uuid() })

/**
 * Described here rather than in `@imogen/shared` because no client outside this web app
 * asks for it yet. Exposing repairs over MCP needs an `admin` OAuth scope, which lives in
 * the SDK and would make this a cross-repo change; that is deliberately a separate piece
 * of work, once the panel has proved the shape.
 */
const AdminRepair = z.object({
  name: z.enum(Object.keys(REPAIRS) as [string, ...string[]]),
  title: z.string(),
  description: z.string(),
  /** Rows the pass will open. Not a promise of how many will move; see the description. */
  candidates: z.number().int(),
  state: z.enum(['idle', 'running', 'done']),
})

/**
 * The administration API.
 *
 * Guarded as a whole rather than route by route, so a new endpoint added here is
 * hidden by default and cannot be left exposed by forgetting a line.
 */
export function createAdminRoutes() {
  const app = new OpenAPIHono<AppEnv>()
  app.use('*', requireHiddenAdmin())

  app.openapi(
    createRoute({
      method: 'get',
      path: '/users',
      tags: ['Admin'],
      summary: 'List every account on the server',
      security: security(),
      responses: { ...ok(AdminUserList, 'The accounts'), ...ERROR_RESPONSES },
    }),
    async (c) => {
      const items = await c.get('services').admin.users()
      return c.json({ items }, 200)
    },
  )

  app.openapi(
    createRoute({
      method: 'patch',
      path: '/users/{id}',
      tags: ['Admin'],
      summary: 'Change an account’s role, or take its access away',
      security: security(),
      request: {
        params: IdParam,
        body: { content: { 'application/json': { schema: AdminUserUpdate } } },
      },
      responses: { ...ok(AdminUser, 'The updated account'), ...ERROR_RESPONSES },
    }),
    async (c) => {
      const services = c.get('services')
      const updated = await services.admin.updateUser(c.req.valid('param').id, c.req.valid('json'))
      return c.json(updated, 200)
    },
  )

  app.openapi(
    createRoute({
      method: 'delete',
      path: '/users/{id}',
      tags: ['Admin'],
      summary: 'Delete an account and send its photos to the trash',
      description:
        'The account goes at once. Its photographs are trashed rather than destroyed, so the existing retention sweep clears them and a mistake stays recoverable.',
      security: security(),
      request: { params: IdParam },
      responses: { ...NO_CONTENT, ...ERROR_RESPONSES },
    }),
    async (c) => {
      const services = c.get('services')
      await services.admin.deleteUser(c.req.valid('param').id)
      return c.body(null, 204)
    },
  )

  app.openapi(
    createRoute({
      method: 'post',
      path: '/users/{id}/password',
      tags: ['Admin'],
      summary: 'Set a password on someone’s behalf',
      security: security(),
      request: {
        params: IdParam,
        body: { content: { 'application/json': { schema: AdminPasswordReset } } },
      },
      responses: { ...NO_CONTENT, ...ERROR_RESPONSES },
    }),
    async (c) => {
      const services = c.get('services')
      const hash = await services.accounts.hashPassword(c.req.valid('json').password)
      await services.admin.resetPassword(c.req.valid('param').id, hash)
      return c.body(null, 204)
    },
  )

  app.openapi(
    createRoute({
      method: 'get',
      path: '/invites',
      tags: ['Admin'],
      summary: 'List invitations',
      description: 'Tokens are stored hashed and are never returned here.',
      security: security(),
      responses: {
        ...ok(z.object({ items: z.array(Invite) }), 'The invitations'),
        ...ERROR_RESPONSES,
      },
    }),
    async (c) => {
      const items = await c.get('services').admin.invites()
      return c.json({ items }, 200)
    },
  )

  app.openapi(
    createRoute({
      method: 'post',
      path: '/invites',
      tags: ['Admin'],
      summary: 'Invite someone to open an account',
      description: 'The token comes back exactly once. It is stored only as a hash.',
      security: security(),
      request: { body: { content: { 'application/json': { schema: InviteCreate } } } },
      responses: { ...created(InviteCreated, 'The invitation'), ...ERROR_RESPONSES },
    }),
    async (c) => {
      const services = c.get('services')
      const invite = await services.admin.createInvite(
        c.get('principal').user.id,
        c.req.valid('json'),
      )
      return c.json(invite, 201)
    },
  )

  app.openapi(
    createRoute({
      method: 'delete',
      path: '/invites/{id}',
      tags: ['Admin'],
      summary: 'Revoke an invitation',
      security: security(),
      request: { params: IdParam },
      responses: { ...NO_CONTENT, ...ERROR_RESPONSES },
    }),
    async (c) => {
      await c.get('services').admin.revokeInvite(c.req.valid('param').id)
      return c.body(null, 204)
    },
  )

  app.openapi(
    createRoute({
      method: 'get',
      path: '/queue',
      tags: ['Admin'],
      summary: 'What the background pipeline is doing',
      security: security(),
      responses: { ...ok(QueueHealth, 'The state of the queue'), ...ERROR_RESPONSES },
    }),
    async (c) => c.json(await c.get('services').admin.queueHealth(), 200),
  )

  app.openapi(
    createRoute({
      method: 'post',
      path: '/queue/retry',
      tags: ['Admin'],
      summary: 'Put every failed job back in the queue',
      security: security(),
      responses: { ...ok(z.object({ count: z.number().int() }), 'How many'), ...ERROR_RESPONSES },
    }),
    async (c) => {
      const count = await c.get('services').admin.retryJobs()
      return c.json({ count }, 200)
    },
  )

  app.openapi(
    createRoute({
      method: 'post',
      path: '/queue/{id}/retry',
      tags: ['Admin'],
      summary: 'Put one job back in the queue',
      security: security(),
      request: { params: IdParam },
      responses: { ...NO_CONTENT, ...ERROR_RESPONSES },
    }),
    async (c) => {
      await c.get('services').admin.retryJobs(c.req.valid('param').id)
      return c.body(null, 204)
    },
  )

  app.openapi(
    createRoute({
      method: 'delete',
      path: '/queue/{id}',
      tags: ['Admin'],
      summary: 'Discard a job that is never going to work',
      security: security(),
      request: { params: IdParam },
      responses: { ...NO_CONTENT, ...ERROR_RESPONSES },
    }),
    async (c) => {
      await c.get('services').admin.discardJob(c.req.valid('param').id)
      return c.body(null, 204)
    },
  )

  app.openapi(
    createRoute({
      method: 'get',
      path: '/repairs',
      tags: ['Admin'],
      summary: 'One-off repairs of values stored before a defect was fixed',
      description:
        'A preview. Nothing here runs on its own: each pass rewrites stored values across every account with no undo, so it waits to be started.',
      security: security(),
      responses: {
        ...ok(z.object({ items: z.array(AdminRepair) }), 'The repairs'),
        ...ERROR_RESPONSES,
      },
    }),
    async (c) => c.json({ items: await c.get('services').admin.repairs() }, 200),
  )

  app.openapi(
    createRoute({
      method: 'post',
      path: '/repairs/{name}',
      tags: ['Admin'],
      summary: 'Start a repair pass',
      description:
        'Queues the walk. It pages through the library re-enqueueing itself, so progress shows in the queue above and a restart resumes rather than starting over.',
      security: security(),
      request: { params: z.object({ name: z.string() }) },
      responses: { ...NO_CONTENT, ...ERROR_RESPONSES },
    }),
    async (c) => {
      const { name } = c.req.valid('param')
      if (!isRepairName(name)) throw notFound('No such repair')
      await c.get('services').admin.startRepair(name)
      return c.body(null, 204)
    },
  )

  app.openapi(
    createRoute({
      method: 'get',
      path: '/clients',
      tags: ['Admin'],
      summary: 'Applications allowed to act on someone’s behalf',
      security: security(),
      responses: {
        ...ok(z.object({ items: z.array(AdminClient) }), 'The applications'),
        ...ERROR_RESPONSES,
      },
    }),
    async (c) => c.json({ items: await c.get('services').admin.clients() }, 200),
  )

  app.openapi(
    createRoute({
      method: 'delete',
      path: '/clients/{clientId}',
      tags: ['Admin'],
      summary: 'Revoke an application and every token it holds',
      security: security(),
      request: { params: z.object({ clientId: z.string() }) },
      responses: { ...NO_CONTENT, ...ERROR_RESPONSES },
    }),
    async (c) => {
      await c.get('services').admin.revokeClient(c.req.valid('param').clientId)
      return c.body(null, 204)
    },
  )

  app.openapi(
    createRoute({
      method: 'get',
      path: '/sessions',
      tags: ['Admin'],
      summary: 'Signed-in browsers',
      security: security(),
      responses: {
        ...ok(z.object({ items: z.array(AdminSession) }), 'The sessions'),
        ...ERROR_RESPONSES,
      },
    }),
    async (c) => {
      const items = await c.get('services').admin.sessions(c.get('principal').sessionId)
      return c.json({ items }, 200)
    },
  )

  app.openapi(
    createRoute({
      method: 'delete',
      path: '/sessions/{id}',
      tags: ['Admin'],
      summary: 'End a session',
      security: security(),
      request: { params: IdParam },
      responses: { ...NO_CONTENT, ...ERROR_RESPONSES },
    }),
    async (c) => {
      await c
        .get('services')
        .admin.revokeSession(c.req.valid('param').id, c.get('principal').sessionId)
      return c.body(null, 204)
    },
  )

  app.openapi(
    createRoute({
      method: 'get',
      path: '/storage',
      tags: ['Admin'],
      summary: 'Where the bytes are',
      security: security(),
      responses: { ...ok(StorageReport, 'The storage report'), ...ERROR_RESPONSES },
    }),
    async (c) => {
      const services = c.get('services')
      return c.json(await services.admin.storage(services.config.dataDir), 200)
    },
  )

  app.openapi(
    createRoute({
      method: 'get',
      path: '/settings',
      tags: ['Admin'],
      summary: 'Settings that can be changed without a restart',
      security: security(),
      responses: { ...ok(ServerSettings, 'The settings'), ...ERROR_RESPONSES },
    }),
    async (c) => {
      const services = c.get('services')
      const facesEnabled = await services.faces.isEnabled()
      return c.json(await services.admin.serverSettings(facesEnabled), 200)
    },
  )

  app.openapi(
    createRoute({
      method: 'patch',
      path: '/settings',
      tags: ['Admin'],
      summary: 'Change a setting',
      description: 'Takes effect immediately. The stored value wins over the environment.',
      security: security(),
      request: { body: { content: { 'application/json': { schema: ServerSettingsUpdate } } } },
      responses: { ...ok(ServerSettings, 'The settings'), ...ERROR_RESPONSES },
    }),
    async (c) => {
      const services = c.get('services')
      const patch = c.req.valid('json')
      await services.admin.updateSettings(patch)
      if (patch.facesEnabled !== undefined) await services.faces.setEnabled(patch.facesEnabled)
      const facesEnabled = await services.faces.isEnabled()
      return c.json(await services.admin.serverSettings(facesEnabled), 200)
    },
  )

  app.openapi(
    createRoute({
      method: 'get',
      path: '/shares',
      tags: ['Admin'],
      summary: 'Every link that is public right now',
      security: security(),
      responses: {
        ...ok(z.object({ items: z.array(AdminShareLink) }), 'The links'),
        ...ERROR_RESPONSES,
      },
    }),
    async (c) => {
      const services = c.get('services')
      const items = await services.admin.shareLinks(services.config.publicUrl)
      return c.json({ items }, 200)
    },
  )

  app.openapi(
    createRoute({
      method: 'delete',
      path: '/shares/{id}',
      tags: ['Admin'],
      summary: 'Close a public link, whoever made it',
      security: security(),
      request: { params: IdParam },
      responses: { ...NO_CONTENT, ...ERROR_RESPONSES },
    }),
    async (c) => {
      await c.get('services').admin.revokeShareLink(c.req.valid('param').id)
      return c.body(null, 204)
    },
  )

  return app
}
