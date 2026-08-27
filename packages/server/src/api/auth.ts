import { createRoute, OpenAPIHono } from '@hono/zod-openapi'
import type { ErrorCode } from '@imogen/shared'
import {
  AuthConfig,
  LoginRequest,
  PasswordChangeRequest,
  ProfileUpdate,
  SignupRequest,
  User,
} from '@imogen/shared'
import type { Context } from 'hono'
import { deleteCookie, setCookie } from 'hono/cookie'
import { AuthError, toPublicUser } from '../auth/accounts.ts'
import { type AppEnv, requireAuth } from '../auth/middleware.ts'
import { SESSION_COOKIE } from '../auth/sessions.ts'
import { badRequest, HttpError, unauthorized } from '../lib/errors.ts'
import { ERROR_RESPONSES, NO_CONTENT, ok, security } from './openapi.ts'

export function createAuthRoutes() {
  const app = new OpenAPIHono<AppEnv>()

  app.openapi(
    createRoute({
      method: 'get',
      path: '/config',
      tags: ['Auth'],
      summary: 'What the sign-in page needs before anyone has authenticated',
      responses: ok(AuthConfig, 'Sign-in options for this server'),
    }),
    async (c) => {
      const { accounts, oidc, settings } = c.get('services')
      const needsSetup = (await accounts.countUsers()) === 0
      return c.json(
        AuthConfig.parse({
          allowSignup: await settings.allowSignup(),
          needsSetup,
          oidc: oidc
            ? {
                enabled: true,
                label: oidc.label,
                startUrl: '/api/v1/auth/oidc/start',
                accountUrl: oidc.accountUrl,
              }
            : { enabled: false },
        }),
        200,
      )
    },
  )

  app.openapi(
    createRoute({
      method: 'post',
      path: '/signup',
      tags: ['Auth'],
      summary: 'Create an account. The first account on a server becomes its administrator.',
      request: { body: { content: { 'application/json': { schema: SignupRequest } } } },
      responses: { ...ok(User, 'The new account'), ...ERROR_RESPONSES },
    }),
    async (c) => {
      const services = c.get('services')
      const body = c.req.valid('json')
      try {
        const user = await services.accounts.signup(body)
        await issueSession(c, user.id)
        return c.json(user, 200)
      } catch (error) {
        throw asHttpError(error)
      }
    },
  )

  app.openapi(
    createRoute({
      method: 'post',
      path: '/login',
      tags: ['Auth'],
      summary: 'Sign in with an email address and password',
      request: { body: { content: { 'application/json': { schema: LoginRequest } } } },
      responses: { ...ok(User, 'The signed-in account'), ...ERROR_RESPONSES },
    }),
    async (c) => {
      const services = c.get('services')
      const { email, password } = c.req.valid('json')
      const row = await services.accounts.verifyPassword(email, password)
      // One message for both cases, so this cannot be used to discover which
      // email addresses have accounts.
      if (!row) throw unauthorized('That email address and password do not match')
      await issueSession(c, row.id)
      return c.json(toPublicUser(row), 200)
    },
  )

  app.openapi(
    createRoute({
      method: 'post',
      path: '/logout',
      tags: ['Auth'],
      summary: 'Sign out of this device',
      responses: NO_CONTENT,
    }),
    async (c) => {
      const services = c.get('services')
      const token = c.req.raw.headers.get('cookie')?.match(/imogen_session=([^;]+)/)?.[1]
      if (token) await services.sessions.revoke(decodeURIComponent(token))
      deleteCookie(c, SESSION_COOKIE, { path: '/' })
      return c.body(null, 204)
    },
  )

  const authed = new OpenAPIHono<AppEnv>()
  authed.use('*', requireAuth())

  authed.openapi(
    createRoute({
      method: 'get',
      path: '/me',
      tags: ['Auth'],
      summary: 'The signed-in account',
      security: security(),
      responses: { ...ok(User, 'The signed-in account'), ...ERROR_RESPONSES },
    }),
    async (c) => c.json(toPublicUser(c.get('principal').user), 200),
  )

  authed.openapi(
    createRoute({
      method: 'patch',
      path: '/me',
      tags: ['Auth'],
      summary: 'Edit your name or email address',
      description:
        'Accounts linked to an identity provider cannot change these here — the provider ' +
        'owns them and imogen re-reads them at every sign-in.',
      security: security(),
      request: { body: { content: { 'application/json': { schema: ProfileUpdate } } } },
      responses: { ...ok(User, 'The updated account'), ...ERROR_RESPONSES },
    }),
    async (c) => {
      const services = c.get('services')
      const principal = c.get('principal')
      // Identity-level changes need a person, not a token.
      if (principal.via !== 'session') {
        throw unauthorized('Sign in through the web interface to change your profile')
      }
      try {
        return c.json(
          await services.accounts.updateProfile(principal.user.id, c.req.valid('json')),
          200,
        )
      } catch (error) {
        throw asHttpError(error)
      }
    },
  )

  authed.openapi(
    createRoute({
      method: 'post',
      path: '/password',
      tags: ['Auth'],
      summary: 'Change the account password',
      security: security(),
      request: { body: { content: { 'application/json': { schema: PasswordChangeRequest } } } },
      responses: { ...NO_CONTENT, ...ERROR_RESPONSES },
    }),
    async (c) => {
      const services = c.get('services')
      const principal = c.get('principal')
      // Only a browser session may change a password; an API token must not be
      // able to lock the owner out of their own account.
      if (principal.via !== 'session') {
        throw unauthorized('Sign in through the web interface to change your password')
      }
      try {
        await services.accounts.changePassword(principal.user.id, c.req.valid('json'))
      } catch (error) {
        throw asHttpError(error)
      }
      // A password change ends every other session, which is the point of changing it.
      await services.sessions.revokeAllForUser(principal.user.id)
      await issueSession(c, principal.user.id)
      return c.body(null, 204)
    },
  )

  authed.openapi(
    createRoute({
      method: 'post',
      path: '/logout-everywhere',
      tags: ['Auth'],
      summary: 'Sign out of every device',
      security: security(),
      responses: { ...NO_CONTENT, ...ERROR_RESPONSES },
    }),
    async (c) => {
      const services = c.get('services')
      await services.sessions.revokeAllForUser(c.get('principal').user.id)
      deleteCookie(c, SESSION_COOKIE, { path: '/' })
      return c.body(null, 204)
    },
  )

  // --- OIDC single sign-on ---
  // These redirect a browser rather than returning JSON, so they stay out of the
  // OpenAPI document that describes the machine-readable API.
  //
  // They MUST be registered before `app.route('/', authed)` below. That sub-app
  // carries `use('*', requireAuth())`, and Hono runs middleware in registration
  // order, so mounting it first makes it swallow these two routes — nobody could
  // ever begin a sign-in, and the provider's callback would be rejected as
  // unauthenticated. Signing in is precisely the request that has no session yet.

  app.get('/oidc/start', async (c) => {
    const { oidc } = c.get('services')
    if (!oidc) throw badRequest('Single sign-on is not configured on this server')
    const returnTo = c.req.query('returnTo') ?? '/'
    return c.redirect(await oidc.startLogin(safeReturnTo(returnTo)))
  })

  app.get('/oidc/callback', async (c) => {
    const services = c.get('services')
    if (!services.oidc) throw badRequest('Single sign-on is not configured on this server')

    const error = c.req.query('error')
    if (error) {
      return c.redirect(`/login?error=${encodeURIComponent(error)}`)
    }

    try {
      const { claims, returnTo } = await services.oidc.completeLogin(new URL(c.req.url))
      const user = await services.accounts.upsertFromOidc(claims)
      await issueSession(c, user.id)
      return c.redirect(returnTo)
    } catch (cause) {
      const message = cause instanceof AuthError ? cause.message : 'Single sign-on failed'
      return c.redirect(`/login?error=${encodeURIComponent(message)}`)
    }
  })

  // Everything below here requires a session. Keep it last: see the note above.
  app.route('/', authed)

  return app
}

/** Only same-origin paths, so a crafted link cannot bounce a user off-site after login. */
function safeReturnTo(value: string): string {
  return value.startsWith('/') && !value.startsWith('//') ? value : '/'
}

async function issueSession(c: Context<AppEnv>, userId: string) {
  const services = c.get('services')
  const { token, expiresAt } = await services.sessions.create(userId, {
    userAgent: c.req.header('user-agent') ?? null,
    ipAddress:
      c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ?? c.req.header('x-real-ip') ?? null,
  })
  setCookie(
    c,
    SESSION_COOKIE,
    token,
    services.sessions.cookieOptions(expiresAt, services.config.publicUrl.startsWith('https://')),
  )
}

/** Turns a service-layer AuthError into the HTTP shape the API contract promises. */
function asHttpError(error: unknown): unknown {
  if (error instanceof AuthError) {
    return new HttpError(error.status as 400, error.code as ErrorCode, error.message)
  }
  return error
}
