import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi'
import {
  Album,
  AlbumAssetsResult,
  AlbumCreate,
  AlbumUpdate,
  AlbumWithAssets,
  AssetSelection,
  ShareLink,
  ShareLinkCreate,
} from '@imogen/shared'
import { type AppEnv, requireAuth, requireScope } from '../auth/middleware.ts'
import { created, ERROR_RESPONSES, NO_CONTENT, ok, security } from './openapi.ts'

const IdParam = z.object({ id: z.uuid() })

export function createAlbumRoutes() {
  const app = new OpenAPIHono<AppEnv>()
  app.use('*', requireAuth())

  app.openapi(
    createRoute({
      method: 'get',
      path: '/',
      tags: ['Albums'],
      summary: 'List albums',
      security: security(),
      middleware: [requireScope('albums:read')] as const,
      responses: {
        ...ok(z.object({ items: z.array(Album) }), 'Your albums, most recently updated first'),
        ...ERROR_RESPONSES,
      },
    }),
    async (c) => {
      const services = c.get('services')
      const items = await services.albums.list(c.get('principal').user.id)
      return c.json({ items }, 200)
    },
  )

  app.openapi(
    createRoute({
      method: 'post',
      path: '/',
      tags: ['Albums'],
      summary: 'Create an album',
      security: security(),
      middleware: [requireScope('albums:write')] as const,
      request: { body: { content: { 'application/json': { schema: AlbumCreate } } } },
      responses: { ...created(Album, 'The new album'), ...ERROR_RESPONSES },
    }),
    async (c) => {
      const services = c.get('services')
      const album = await services.albums.create(c.get('principal').user.id, c.req.valid('json'))
      return c.json(album, 201)
    },
  )

  app.openapi(
    createRoute({
      method: 'get',
      path: '/{id}',
      tags: ['Albums'],
      summary: 'One album, with a cover sample of its photos',
      security: security(),
      middleware: [requireScope('albums:read')] as const,
      request: { params: IdParam },
      responses: { ...ok(AlbumWithAssets, 'The album'), ...ERROR_RESPONSES },
    }),
    async (c) => {
      const services = c.get('services')
      const album = await services.albums.getWithAssets(
        c.get('principal').user.id,
        c.req.valid('param').id,
      )
      return c.json(album, 200)
    },
  )

  app.openapi(
    createRoute({
      method: 'patch',
      path: '/{id}',
      tags: ['Albums'],
      summary: 'Rename or re-cover an album',
      security: security(),
      middleware: [requireScope('albums:write')] as const,
      request: {
        params: IdParam,
        body: { content: { 'application/json': { schema: AlbumUpdate } } },
      },
      responses: { ...ok(Album, 'The updated album'), ...ERROR_RESPONSES },
    }),
    async (c) => {
      const services = c.get('services')
      const album = await services.albums.update(
        c.get('principal').user.id,
        c.req.valid('param').id,
        c.req.valid('json'),
      )
      return c.json(album, 200)
    },
  )

  app.openapi(
    createRoute({
      method: 'delete',
      path: '/{id}',
      tags: ['Albums'],
      summary: 'Delete an album',
      description: 'The photos stay in your library; only the album is removed.',
      security: security(),
      middleware: [requireScope('albums:write')] as const,
      request: { params: IdParam },
      responses: { ...NO_CONTENT, ...ERROR_RESPONSES },
    }),
    async (c) => {
      const services = c.get('services')
      await services.albums.remove(c.get('principal').user.id, c.req.valid('param').id)
      return c.body(null, 204)
    },
  )

  app.openapi(
    createRoute({
      method: 'post',
      path: '/{id}/assets',
      tags: ['Albums'],
      summary: 'Add photos to an album',
      description: 'Idempotent: adding a photo that is already there is counted as skipped.',
      security: security(),
      middleware: [requireScope('albums:write')] as const,
      request: {
        params: IdParam,
        body: { content: { 'application/json': { schema: AssetSelection } } },
      },
      responses: { ...ok(AlbumAssetsResult, 'What changed'), ...ERROR_RESPONSES },
    }),
    async (c) => {
      const services = c.get('services')
      const ownerId = c.get('principal').user.id
      const assetIds = await services.assets.resolveSelection(ownerId, c.req.valid('json'))
      const result = await services.albums.addAssets(ownerId, c.req.valid('param').id, assetIds)
      return c.json(result, 200)
    },
  )

  app.openapi(
    createRoute({
      method: 'delete',
      path: '/{id}/assets',
      tags: ['Albums'],
      summary: 'Remove photos from an album',
      security: security(),
      middleware: [requireScope('albums:write')] as const,
      request: {
        params: IdParam,
        body: { content: { 'application/json': { schema: AssetSelection } } },
      },
      responses: {
        ...ok(z.object({ removed: z.number().int().nonnegative() }), 'How many were removed'),
        ...ERROR_RESPONSES,
      },
    }),
    async (c) => {
      const services = c.get('services')
      const ownerId = c.get('principal').user.id
      const assetIds = await services.assets.resolveSelection(ownerId, c.req.valid('json'))
      const removed = await services.albums.removeAssets(ownerId, c.req.valid('param').id, assetIds)
      return c.json({ removed }, 200)
    },
  )

  app.openapi(
    createRoute({
      method: 'post',
      path: '/{id}/share',
      tags: ['Albums'],
      summary: 'Create a public link to an album',
      description: 'Replaces any existing link, so an album has at most one live URL.',
      security: security(),
      middleware: [requireScope('albums:write')] as const,
      request: {
        params: IdParam,
        body: { content: { 'application/json': { schema: ShareLinkCreate } } },
      },
      responses: { ...created(ShareLink, 'The share link'), ...ERROR_RESPONSES },
    }),
    async (c) => {
      const services = c.get('services')
      const link = await services.albums.createShareLink(
        c.get('principal').user.id,
        c.req.valid('param').id,
        c.req.valid('json'),
        services.config.publicUrl,
      )
      return c.json(link, 201)
    },
  )

  app.openapi(
    createRoute({
      method: 'delete',
      path: '/{id}/share',
      tags: ['Albums'],
      summary: 'Revoke an album’s public link',
      security: security(),
      middleware: [requireScope('albums:write')] as const,
      request: { params: IdParam },
      responses: { ...NO_CONTENT, ...ERROR_RESPONSES },
    }),
    async (c) => {
      const services = c.get('services')
      await services.albums.revokeShareLink(c.get('principal').user.id, c.req.valid('param').id)
      return c.body(null, 204)
    },
  )

  app.openapi(
    createRoute({
      method: 'get',
      path: '/{id}/share',
      tags: ['Albums'],
      summary: 'The public link for this album, if it has one',
      security: security(),
      middleware: [requireScope('albums:read')] as const,
      request: { params: IdParam },
      responses: { ...ok(ShareLink.nullable(), 'The link, or null'), ...ERROR_RESPONSES },
    }),
    async (c) => {
      const services = c.get('services')
      const link = await services.albums.albumShareLink(
        c.get('principal').user.id,
        c.req.valid('param').id,
        services.config.publicUrl,
      )
      return c.json(link, 200)
    },
  )

  return app
}
