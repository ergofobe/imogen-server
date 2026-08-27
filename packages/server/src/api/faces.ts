import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi'
import {
  DetectedFace,
  FaceStatus,
  MergePeople,
  Person,
  PersonUpdate,
  PersonWithPhotos,
  ReassignFaces,
} from '@imogen/shared'
import { eq } from 'drizzle-orm'
import sharp from 'sharp'
import { type AppEnv, requireAdmin, requireAuth, requireScope } from '../auth/middleware.ts'
import { faces as facesTable } from '../db/schema.ts'
import { countUnscanned, FACE_BACKFILL_JOB, FACE_MODELS_JOB } from '../jobs/faces.ts'
import { notFound } from '../lib/errors.ts'
import { toAsset } from '../media/serialize.ts'
import { ERROR_RESPONSES, NO_CONTENT, ok, security } from './openapi.ts'
import { vaultIsOpen } from './vault.ts'

const IdParam = z.object({ id: z.uuid() })

export function createFaceRoutes() {
  const app = new OpenAPIHono<AppEnv>()
  app.use('*', requireAuth())

  app.openapi(
    createRoute({
      method: 'get',
      path: '/status',
      tags: ['People'],
      summary: 'Whether face grouping is switched on, and how far it has got',
      security: security(),
      responses: { ...ok(FaceStatus, 'Face grouping status'), ...ERROR_RESPONSES },
    }),
    async (c) => {
      const services = c.get('services')
      const models = await services.models.status()
      return c.json(
        {
          enabled: await services.faces.isEnabled(),
          modelsReady: models.every((m) => m.present),
          models,
          peopleCount: (await services.faces.listPeople(c.get('principal').user.id)).length,
          pending: await countUnscanned(services.db),
        },
        200,
      )
    },
  )

  app.openapi(
    createRoute({
      method: 'post',
      path: '/enable',
      tags: ['People'],
      summary: 'Turn face grouping on or off for this server',
      description:
        'Enabling downloads the recognition models onto the server and scans the ' +
        'existing library. Off by default: scanning somebody’s whole library for faces ' +
        'is not a decision imogen makes on their behalf.',
      security: security(),
      middleware: [requireAdmin()] as const,
      request: {
        body: { content: { 'application/json': { schema: z.object({ enabled: z.boolean() }) } } },
      },
      responses: { ...NO_CONTENT, ...ERROR_RESPONSES },
    }),
    async (c) => {
      const services = c.get('services')
      const { enabled } = c.req.valid('json')
      await services.faces.setEnabled(enabled)

      if (enabled) {
        // Downloading is slow and the models are large, so it happens in the background.
        const ready = await services.models.isReady()
        // 190 MB over a home connection deserves more than the default handful of
        // attempts: giving up leaves the server permanently unable to scan anything.
        await services.queue.enqueue(
          ready ? FACE_BACKFILL_JOB : FACE_MODELS_JOB,
          {},
          ready ? {} : { maxAttempts: 10 },
        )
      }
      return c.body(null, 204)
    },
  )

  app.openapi(
    createRoute({
      method: 'get',
      path: '/',
      tags: ['People'],
      summary: 'Everyone the library has grouped',
      security: security(),
      middleware: [requireScope('library:read')] as const,
      request: { query: z.object({ includeHidden: z.coerce.boolean().default(false) }) },
      responses: {
        ...ok(z.object({ items: z.array(Person) }), 'People, most photographed first'),
        ...ERROR_RESPONSES,
      },
    }),
    async (c) => {
      const services = c.get('services')
      const rows = await services.faces.listPeople(
        c.get('principal').user.id,
        c.req.valid('query').includeHidden,
      )
      return c.json({ items: rows.map((p) => ({ ...p, photoCount: p.faceCount })) }, 200)
    },
  )

  app.openapi(
    createRoute({
      method: 'get',
      path: '/{id}',
      tags: ['People'],
      summary: 'One person and the photos they appear in',
      security: security(),
      middleware: [requireScope('library:read')] as const,
      request: { params: IdParam },
      responses: { ...ok(PersonWithPhotos, 'The person'), ...ERROR_RESPONSES },
    }),
    async (c) => {
      const services = c.get('services')
      const ownerId = c.get('principal').user.id
      const id = c.req.valid('param').id

      const person = await services.faces.getPerson(ownerId, id)
      const photos = await services.faces.photosOf(ownerId, id)
      return c.json(
        {
          id: person.id,
          name: person.name,
          coverFaceId: person.coverFaceId,
          photoCount: photos.length,
          hidden: person.hidden,
          photos: photos.map(toAsset),
        },
        200,
      )
    },
  )

  app.openapi(
    createRoute({
      method: 'patch',
      path: '/{id}',
      tags: ['People'],
      summary: 'Name a person, or hide them',
      security: security(),
      middleware: [requireScope('library:write')] as const,
      request: {
        params: IdParam,
        body: { content: { 'application/json': { schema: PersonUpdate } } },
      },
      responses: { ...NO_CONTENT, ...ERROR_RESPONSES },
    }),
    async (c) => {
      const services = c.get('services')
      const ownerId = c.get('principal').user.id
      const id = c.req.valid('param').id
      const patch = c.req.valid('json')

      if (patch.name !== undefined) await services.faces.renamePerson(ownerId, id, patch.name)
      if (patch.hidden !== undefined) await services.faces.setHidden(ownerId, id, patch.hidden)
      return c.body(null, 204)
    },
  )

  app.openapi(
    createRoute({
      method: 'post',
      path: '/merge',
      tags: ['People'],
      summary: 'Fold several clusters into one person',
      description: 'Use this when grouping split one person across two or more clusters.',
      security: security(),
      middleware: [requireScope('library:write')] as const,
      request: { body: { content: { 'application/json': { schema: MergePeople } } } },
      responses: {
        ...ok(z.object({ moved: z.number().int().nonnegative() }), 'How many faces moved'),
        ...ERROR_RESPONSES,
      },
    }),
    async (c) => {
      const services = c.get('services')
      const { keepId, mergeIds } = c.req.valid('json')
      const moved = await services.faces.mergePeople(c.get('principal').user.id, keepId, mergeIds)
      return c.json({ moved }, 200)
    },
  )

  app.openapi(
    createRoute({
      method: 'post',
      path: '/reassign',
      tags: ['People'],
      summary: 'Move specific faces to a different person',
      description: 'The fix when grouping put one person’s face under somebody else.',
      security: security(),
      middleware: [requireScope('library:write')] as const,
      request: { body: { content: { 'application/json': { schema: ReassignFaces } } } },
      responses: { ...NO_CONTENT, ...ERROR_RESPONSES },
    }),
    async (c) => {
      const services = c.get('services')
      const { faceIds, personId } = c.req.valid('json')
      await services.faces.reassignFaces(c.get('principal').user.id, faceIds, personId)
      return c.body(null, 204)
    },
  )

  app.openapi(
    createRoute({
      method: 'get',
      path: '/faces/{id}',
      tags: ['People'],
      summary: 'The faces found in one photo',
      security: security(),
      middleware: [requireScope('library:read')] as const,
      request: { params: IdParam },
      responses: {
        ...ok(z.object({ items: z.array(DetectedFace) }), 'Faces in that photo'),
        ...ERROR_RESPONSES,
      },
    }),
    async (c) => {
      const services = c.get('services')
      const ownerId = c.get('principal').user.id
      const assetId = c.req.valid('param').id
      // Reuses the asset check, so a vaulted photo's faces need the vault open.
      await services.assets.get(ownerId, assetId, { includeVaulted: vaultIsOpen(c) })
      return c.json({ items: await services.faces.facesForAsset(ownerId, assetId) }, 200)
    },
  )

  /**
   * A person's thumbnail: their best face, cropped from the photo it was found in.
   * Outside the OpenAPI document because a client wants a URL here, not a generated
   * method returning bytes.
   */
  app.get('/thumbnail/:faceId', requireScope('library:read'), async (c) => {
    const services = c.get('services')
    const ownerId = c.get('principal').user.id

    const [face] = await services.db
      .select()
      .from(facesTable)
      .where(eq(facesTable.id, c.req.param('faceId')))
      .limit(1)
    if (!face || face.ownerId !== ownerId) throw notFound('No such face')

    // Goes through the asset check, so a vaulted photo cannot leak a face crop.
    await services.assets.get(ownerId, face.assetId, { includeVaulted: vaultIsOpen(c) })

    const file = await services.db.query.assetFiles
      .findFirst({
        where: (t, { and: whereAnd, eq: whereEq }) =>
          whereAnd(whereEq(t.assetId, face.assetId), whereEq(t.variant, 'original')),
      })
      .catch(() => null)
    if (!file) throw notFound('That photo is no longer available')

    // A little margin, so the crop reads as a portrait rather than a cut-out.
    const margin = Math.round(Math.max(face.width, face.height) * 0.25)
    const source = services.library.absolutePath(file.path)
    // Rotated first: the stored coordinates are in the upright frame, as detection saw it.
    const upright = await sharp(source).rotate().toBuffer({ resolveWithObject: true })
    const meta = upright.info
    const left = Math.max(0, face.x - margin)
    const top = Math.max(0, face.y - margin)

    const crop = await sharp(upright.data)
      .extract({
        left,
        top,
        width: Math.min(face.width + margin * 2, meta.width - left),
        height: Math.min(face.height + margin * 2, meta.height - top),
      })
      .resize(160, 160, { fit: 'cover' })
      .webp({ quality: 80 })
      .toBuffer()

    return new Response(new Uint8Array(crop), {
      headers: {
        'Content-Type': 'image/webp',
        // Keyed by face id, and a face's crop never changes.
        'Cache-Control': 'private, max-age=31536000, immutable',
        ETag: `"face-${face.id}"`,
      },
    })
  })

  return app
}
