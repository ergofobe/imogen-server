import { appendFile, mkdir, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi'
import {
  AssetUploadMetadata,
  AssetUploadResult,
  UploadSession,
  UploadSessionCreate,
} from '@imogen/shared'
import { and, eq } from 'drizzle-orm'
import { type AppEnv, requireAuth, requireScope } from '../auth/middleware.ts'
import { assets, uploadSessions } from '../db/schema.ts'
import { badRequest, conflict, notFound } from '../lib/errors.ts'
import { created, ERROR_RESPONSES, ok, security } from './openapi.ts'

const SESSION_TTL_HOURS = 24

const IdParam = z.object({ id: z.uuid() })

/**
 * Resumable uploads, for clients that cannot afford to restart a 2 GB video because a
 * train went into a tunnel. A session records how many bytes have landed; a resuming
 * client asks, then continues from there.
 */
export function createUploadRoutes() {
  const app = new OpenAPIHono<AppEnv>()
  app.use('*', requireAuth())

  app.openapi(
    createRoute({
      method: 'post',
      path: '/',
      tags: ['Uploads'],
      summary: 'Begin a resumable upload',
      description:
        'Supply the checksum if you know it and the server will tell you immediately ' +
        'whether it already has the file, so nothing is transferred twice.',
      security: security(),
      middleware: [requireScope('library:write')] as const,
      request: { body: { content: { 'application/json': { schema: UploadSessionCreate } } } },
      responses: { ...created(UploadSession, 'The upload session'), ...ERROR_RESPONSES },
    }),
    async (c) => {
      const services = c.get('services')
      const principal = c.get('principal')
      const body = c.req.valid('json')

      if (body.checksum) {
        const [existing] = await services.db
          .select()
          .from(assets)
          .where(and(eq(assets.ownerId, principal.user.id), eq(assets.checksum, body.checksum)))
          .limit(1)
        if (existing) {
          const asset = await services.assets.get(principal.user.id, existing.id)
          return c.json(
            {
              id: crypto.randomUUID(),
              offset: body.sizeBytes,
              sizeBytes: body.sizeBytes,
              expiresAt: new Date().toISOString(),
              existing: { asset, duplicate: true },
            },
            201,
          )
        }
      }

      await mkdir(services.config.uploadsDir, { recursive: true })
      const tempPath = join(services.config.uploadsDir, `${crypto.randomUUID()}.part`)
      await Bun.write(tempPath, '')

      const expiresAt = new Date(Date.now() + SESSION_TTL_HOURS * 3600 * 1000)
      const [row] = await services.db
        .insert(uploadSessions)
        .values({
          userId: principal.user.id,
          filename: body.filename,
          mimeType: body.mimeType,
          sizeBytes: body.sizeBytes,
          tempPath,
          metadata: {
            deviceAssetId: body.deviceAssetId,
            capturedAt: body.capturedAt,
            favorite: body.favorite,
            description: body.description,
            location: body.location,
          },
          expiresAt,
        })
        .returning()

      return c.json(
        {
          id: row!.id,
          offset: 0,
          sizeBytes: row!.sizeBytes,
          expiresAt: expiresAt.toISOString(),
          existing: null,
        },
        201,
      )
    },
  )

  app.openapi(
    createRoute({
      method: 'get',
      path: '/{id}',
      tags: ['Uploads'],
      summary: 'How much of this upload has arrived',
      security: security(),
      middleware: [requireScope('library:write')] as const,
      request: { params: IdParam },
      responses: {
        ...ok(UploadSession, 'The session, with its current offset'),
        ...ERROR_RESPONSES,
      },
    }),
    async (c) => {
      const services = c.get('services')
      const row = await findSession(services, c.get('principal').user.id, c.req.valid('param').id)
      return c.json(
        {
          id: row.id,
          offset: row.receivedBytes,
          sizeBytes: row.sizeBytes,
          expiresAt: row.expiresAt.toISOString(),
          existing: null,
        },
        200,
      )
    },
  )

  // Chunk appends carry raw bytes, so they stay outside the JSON-shaped OpenAPI routes.
  app.patch('/:id', requireScope('library:write'), async (c) => {
    const services = c.get('services')
    const row = await findSession(services, c.get('principal').user.id, c.req.param('id'))

    const offset = Number(c.req.header('upload-offset') ?? c.req.query('offset') ?? NaN)
    if (!Number.isInteger(offset) || offset < 0) {
      throw badRequest('An Upload-Offset header is required')
    }
    // Refusing a mismatched offset is what keeps a retried chunk from corrupting the file.
    if (offset !== row.receivedBytes) {
      throw conflict(`Expected the next chunk at offset ${row.receivedBytes}, not ${offset}`)
    }

    const chunk = Buffer.from(await c.req.arrayBuffer())
    if (row.receivedBytes + chunk.length > row.sizeBytes) {
      throw badRequest('That chunk would exceed the size declared when the upload began')
    }

    await appendFile(row.tempPath, chunk)
    const { size } = await stat(row.tempPath)
    await services.db
      .update(uploadSessions)
      .set({ receivedBytes: size })
      .where(eq(uploadSessions.id, row.id))

    return c.json({ id: row.id, offset: size, sizeBytes: row.sizeBytes }, 200, {
      'Upload-Offset': String(size),
    })
  })

  app.openapi(
    createRoute({
      method: 'post',
      path: '/{id}/complete',
      tags: ['Uploads'],
      summary: 'Finish a resumable upload and register the asset',
      security: security(),
      middleware: [requireScope('library:write')] as const,
      request: { params: IdParam },
      responses: { ...created(AssetUploadResult, 'The stored asset'), ...ERROR_RESPONSES },
    }),
    async (c) => {
      const services = c.get('services')
      const principal = c.get('principal')
      const row = await findSession(services, principal.user.id, c.req.valid('param').id)

      const { size } = await stat(row.tempPath).catch(() => ({ size: -1 }))
      if (size !== row.sizeBytes) {
        throw badRequest(`Upload is incomplete: ${size} of ${row.sizeBytes} bytes received`)
      }

      // The row was written from a validated body, but it may have been written by an
      // older build; a session that cannot be re-validated is ingested without hints
      // rather than refused after its bytes have all arrived.
      const metadata = AssetUploadMetadata.safeParse(row.metadata ?? {})
      try {
        const result = await services.ingest.ingest({
          ownerId: principal.user.id,
          tempPath: row.tempPath,
          filename: row.filename,
          mimeType: row.mimeType,
          metadata: metadata.success ? metadata.data : {},
        })
        return c.json(result, 201)
      } finally {
        // The session is spent either way; ingest has taken or discarded the file.
        await services.db.delete(uploadSessions).where(eq(uploadSessions.id, row.id))
      }
    },
  )

  app.delete('/:id', requireScope('library:write'), async (c) => {
    const services = c.get('services')
    const row = await findSession(services, c.get('principal').user.id, c.req.param('id'))
    await rm(row.tempPath, { force: true })
    await services.db.delete(uploadSessions).where(eq(uploadSessions.id, row.id))
    return c.body(null, 204)
  })

  return app
}

async function findSession(
  services: import('../services.ts').Services,
  userId: string,
  id: string,
) {
  const [row] = await services.db
    .select()
    .from(uploadSessions)
    .where(and(eq(uploadSessions.id, id), eq(uploadSessions.userId, userId)))
    .limit(1)
  if (!row) throw notFound('No such upload session')
  if (row.expiresAt.getTime() <= Date.now()) throw notFound('That upload session has expired')
  return row
}
