import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { OpenAPIHono } from '@hono/zod-openapi'
import { ERROR_CODES } from '@imogen/shared'
import { Scalar } from '@scalar/hono-api-reference'
import type { Hono } from 'hono'
import { logger } from 'hono/logger'
import { secureHeaders } from 'hono/secure-headers'
import manifest from '../package.json'
import { createAdminRoutes } from './api/admin.ts'
import { createAlbumRoutes } from './api/albums.ts'
import { createAssetRoutes } from './api/assets.ts'
import { createAuthRoutes } from './api/auth.ts'
import { createFaceRoutes } from './api/faces.ts'
import { createOAuthRoutes, createWellKnownRoutes } from './api/oauth.ts'
import { createShareRoutes } from './api/share.ts'
import { createUploadRoutes } from './api/uploads.ts'
import { createVaultRoutes } from './api/vault.ts'
import type { AppEnv } from './auth/middleware.ts'
import { respondWithError } from './lib/errors.ts'
import { createMcpRoutes } from './mcp/routes.ts'
import type { Services } from './services.ts'

export type AppOptions = {
  services: Services
  /** Directory holding the built web bundle. Omitted in tests and during `bun dev`. */
  webRoot?: string
}

export function createApp({ services, webRoot }: AppOptions) {
  const app = new OpenAPIHono<AppEnv>({
    // One place turns a schema failure into the error envelope the SDK expects.
    defaultHook: (result, c) => {
      if (result.success) return
      const details: Record<string, string[]> = {}
      for (const issue of result.error.issues) {
        const key = issue.path.join('.') || '_'
        const messages = details[key] ?? []
        messages.push(issue.message)
        details[key] = messages
      }
      return c.json(
        {
          error: {
            code: ERROR_CODES.VALIDATION_FAILED,
            message: 'The request did not match what this endpoint expects',
            details,
          },
        },
        400,
      )
    },
  })

  app.use('*', async (c, next) => {
    c.set('services', services)
    await next()
  })

  if (process.env.NODE_ENV !== 'test') app.use('*', logger())

  /**
   * The API reference is the one page that needs a looser policy, and it says so here
   * rather than trying to overrule the site-wide one later: both write the same
   * header, and whichever runs last wins, which is not a thing to leave to ordering.
   */
  const DOCS_PATH = '/api/v1/docs'

  const siteHeaders = secureHeaders({
    // The web app is same-origin and self-contained; nothing loads from elsewhere.
    contentSecurityPolicy: {
      defaultSrc: ["'self'"],
      imgSrc: ["'self'", 'data:', 'blob:'],
      mediaSrc: ["'self'", 'blob:'],
      styleSrc: ["'self'", "'unsafe-inline'"],
      scriptSrc: ["'self'"],
      connectSrc: ["'self'"],
      frameAncestors: ["'none'"],
    },
    referrerPolicy: 'same-origin',
    crossOriginEmbedderPolicy: false,
  })

  app.use('*', async (c, next) => {
    if (c.req.path === DOCS_PATH) return next()
    return siteHeaders(c, next)
  })

  app.onError((error, c) => respondWithError(c, error))

  // --- Discovery and OAuth, which live at the root because the specs say so ---
  app.route('/.well-known', createWellKnownRoutes())
  app.route('/oauth', createOAuthRoutes())

  // --- MCP ---
  app.route('/mcp', createMcpRoutes())

  // --- Public album shares ---
  app.route('/api/v1/share', createShareRoutes())

  // --- The versioned API ---
  const v1 = new OpenAPIHono<AppEnv>()
  v1.get('/health', (c) => c.json({ status: 'ok', version: VERSION }))
  v1.route('/auth', createAuthRoutes())

  // Each router applies its own authentication. A wildcard across /api/v1 would also
  // cover the OpenAPI document and health check, which must stay reachable.
  v1.route('/assets', createAssetRoutes())
  v1.route('/uploads', createUploadRoutes())
  v1.route('/vault', createVaultRoutes())
  v1.route('/people', createFaceRoutes())
  v1.route('/albums', createAlbumRoutes())
  v1.route('/admin', createAdminRoutes())

  app.route('/api/v1', v1)

  app.doc31('/api/v1/openapi.json', (c) => ({
    openapi: '3.1.0',
    info: {
      title: 'imogen',
      version: VERSION,
      description:
        'The imogen photo library API. Authenticate with a session cookie from the web ' +
        'interface, or with an OAuth 2.1 bearer token obtained through the authorization ' +
        'server described at /.well-known/oauth-authorization-server.',
    },
    servers: [{ url: new URL(c.req.url).origin }],
  }))

  app.openAPIRegistry.registerComponent('securitySchemes', 'sessionCookie', {
    type: 'apiKey',
    in: 'cookie',
    name: 'imogen_session',
  })
  app.openAPIRegistry.registerComponent('securitySchemes', 'oauth2', {
    type: 'oauth2',
    flows: {
      authorizationCode: {
        authorizationUrl: '/oauth/authorize',
        tokenUrl: '/oauth/token',
        scopes: {
          'library:read': 'View photos and videos',
          'library:write': 'Upload, edit, and delete photos and videos',
          'albums:read': 'View albums',
          'albums:write': 'Create and modify albums',
          profile: 'Read name and email address',
        },
      },
    },
  })

  /**
   * The API reference.
   *
   * The viewer is served from this origin rather than a CDN, so the documentation
   * works on a server with no way out to the internet — which is where a home library
   * usually sits, and without it the page is simply blank.
   *
   * Scalar configures itself through an inline script, which the site-wide
   * `script-src 'self'` refuses. The allowance is granted here and nowhere else: this
   * one route renders our own OpenAPI document and nothing a user has supplied.
   */
  app.get(
    DOCS_PATH,
    secureHeaders({
      contentSecurityPolicy: {
        defaultSrc: ["'self'"],
        imgSrc: ["'self'", 'data:', 'blob:'],
        styleSrc: ["'self'", "'unsafe-inline'"],
        scriptSrc: ["'self'", "'unsafe-inline'"],
        connectSrc: ["'self'"],
        frameAncestors: ["'none'"],
      },
      referrerPolicy: 'same-origin',
      crossOriginEmbedderPolicy: false,
    }),
    Scalar({ url: '/api/v1/openapi.json', pageTitle: 'imogen API', cdn: '/scalar.js' }),
  )

  // --- The web application ---
  if (webRoot) mountWebApp(app, webRoot)

  app.notFound((c) =>
    c.json({ error: { code: ERROR_CODES.NOT_FOUND, message: `No route for ${c.req.path}` } }, 404),
  )

  return app
}

/**
 * What /api/v1/health and the OpenAPI document report.
 *
 * Read from the manifest rather than written out again here: cutting a release bumps
 * package.json, and a second copy of the number is a copy that gets forgotten — the
 * health check went on claiming 0.1.0 through three tagged releases.
 */
export const VERSION: string = manifest.version

/**
 * Serves the built single-page app: hashed assets cached forever, everything else
 * falling through to index.html so client-side routes survive a refresh.
 */
function mountWebApp(app: Hono<AppEnv>, webRoot: string) {
  const indexPath = join(webRoot, 'index.html')

  app.get('*', async (c, next) => {
    if (c.req.path.startsWith('/api/') || c.req.path.startsWith('/oauth/')) return next()

    const requested = join(webRoot, c.req.path)
    // Reject traversal before touching the filesystem.
    if (!requested.startsWith(webRoot)) return next()

    const file = Bun.file(requested)
    if (c.req.path !== '/' && (await file.exists())) {
      const immutable = /\/assets\/.+\.[0-9a-f]{8,}\./.test(c.req.path)
      return new Response(file, {
        headers: {
          'Cache-Control': immutable
            ? 'public, max-age=31536000, immutable'
            : 'public, max-age=0, must-revalidate',
        },
      })
    }

    if (!existsSync(indexPath)) return next()
    return new Response(Bun.file(indexPath), {
      headers: { 'Content-Type': 'text/html', 'Cache-Control': 'no-cache' },
    })
  })
}
