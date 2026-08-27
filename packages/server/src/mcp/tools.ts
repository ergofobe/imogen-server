import type { OAuthScope } from '@imogen/shared'
import { z } from 'zod'
import type { Principal } from '../lib/context.ts'
import type { Services } from '../services.ts'

export type ToolContext = { services: Services; principal: Principal }

export type ToolContent =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string }

export type ToolResult = { content: ToolContent[]; isError?: boolean }

export type Tool = {
  name: string
  title: string
  description: string
  scope: OAuthScope
  input: z.ZodType
  run: (args: Record<string, unknown>, ctx: ToolContext) => Promise<ToolResult>
}

const text = (value: string): ToolResult => ({ content: [{ type: 'text', text: value }] })
const json = (value: unknown): ToolResult => text(JSON.stringify(value, null, 2))

/** Trimmed to what an agent needs to reason and to fetch more; not the whole row. */
function summarize(asset: {
  id: string
  originalFilename: string
  type: string
  capturedAt: string
  description: string | null
  favorite: boolean
  width: number | null
  height: number | null
  location: { latitude: number; longitude: number; place: string | null } | null
  exif: { make: string | null; model: string | null } | null
}) {
  return {
    id: asset.id,
    filename: asset.originalFilename,
    type: asset.type,
    takenAt: asset.capturedAt,
    description: asset.description,
    favorite: asset.favorite,
    dimensions: asset.width && asset.height ? `${asset.width}x${asset.height}` : null,
    place: asset.location?.place ?? null,
    coordinates: asset.location
      ? { lat: asset.location.latitude, lon: asset.location.longitude }
      : null,
    camera: asset.exif?.make ? `${asset.exif.make} ${asset.exif.model ?? ''}`.trim() : null,
  }
}

export const TOOLS: Tool[] = [
  {
    name: 'search_photos',
    title: 'Search photos',
    description:
      'Search the photo library by text, date range, place, album, or favourite status. ' +
      'Returns matching photos with their metadata and ids. Use get_photo_image to see one.',
    scope: 'library:read',
    input: z.object({
      query: z
        .string()
        .optional()
        .describe('Free text matched against filename, description, place, and camera'),
      takenAfter: z.string().optional().describe('ISO 8601 date; only photos taken after it'),
      takenBefore: z.string().optional().describe('ISO 8601 date; only photos taken before it'),
      type: z.enum(['image', 'video']).optional(),
      favorite: z.boolean().optional().describe('Only favourites'),
      albumId: z.string().optional(),
      limit: z.number().int().min(1).max(100).default(25),
    }),
    run: async (args, { services, principal }) => {
      const page = await services.assets.list(principal.user.id, {
        limit: (args.limit as number) ?? 25,
        sort: 'capturedAt',
        order: 'desc',
        ...(args.query ? { q: args.query as string } : {}),
        ...(args.takenAfter ? { takenAfter: args.takenAfter as string } : {}),
        ...(args.takenBefore ? { takenBefore: args.takenBefore as string } : {}),
        ...(args.type ? { type: args.type as 'image' | 'video' } : {}),
        ...(args.favorite !== undefined ? { favorite: args.favorite as boolean } : {}),
        ...(args.albumId ? { albumId: args.albumId as string } : {}),
      })
      if (page.items.length === 0) {
        return text('No photos matched that search.')
      }
      return json({ count: page.items.length, photos: page.items.map(summarize) })
    },
  },

  {
    name: 'get_photo',
    title: 'Get photo details',
    description: 'Full metadata for one photo, by id.',
    scope: 'library:read',
    input: z.object({ photoId: z.string().describe('The photo id from search_photos') }),
    run: async (args, { services, principal }) => {
      const asset = await services.assets.get(principal.user.id, args.photoId as string)
      return json({
        ...summarize(asset),
        mimeType: asset.mimeType,
        sizeBytes: asset.sizeBytes,
        durationSeconds: asset.duration,
        exif: asset.exif,
        archived: asset.archived,
        inTrash: asset.deletedAt !== null,
      })
    },
  },

  {
    name: 'get_photo_image',
    title: 'View a photo',
    description:
      'Returns the image itself so it can be looked at. Serves a display-sized preview ' +
      'rather than the original, which keeps large photos usable.',
    scope: 'library:read',
    input: z.object({ photoId: z.string() }),
    run: async (args, { services, principal }) => {
      const photoId = args.photoId as string
      const asset = await services.assets.get(principal.user.id, photoId)
      if (asset.status !== 'ready') {
        return {
          content: [{ type: 'text', text: 'That photo is still being processed.' }],
          isError: true,
        }
      }

      const file = await services.db.query.assetFiles
        .findFirst({
          where: (t, { and, eq }) => and(eq(t.assetId, photoId), eq(t.variant, 'preview')),
        })
        .catch(() => null)
      if (!file) {
        return {
          content: [{ type: 'text', text: 'No preview exists for that photo.' }],
          isError: true,
        }
      }

      const blob = await services.thumbnails.read(file.path)
      const base64 = Buffer.from(await blob.arrayBuffer()).toString('base64')
      return {
        content: [
          { type: 'text', text: `${asset.originalFilename} — taken ${asset.capturedAt}` },
          { type: 'image', data: base64, mimeType: 'image/webp' },
        ],
      }
    },
  },

  {
    name: 'list_albums',
    title: 'List albums',
    description: 'Every album in the library, with how many photos each holds.',
    scope: 'albums:read',
    input: z.object({}),
    run: async (_args, { services, principal }) => {
      const albums = await services.albums.list(principal.user.id)
      if (albums.length === 0) return text('There are no albums yet.')
      return json(
        albums.map((a) => ({
          id: a.id,
          name: a.name,
          description: a.description,
          photoCount: a.assetCount,
          shared: a.shareSlug !== null,
        })),
      )
    },
  },

  {
    name: 'get_album',
    title: 'Get album contents',
    description: 'One album and a cover sample of the photos in it.',
    scope: 'albums:read',
    input: z.object({ albumId: z.string() }),
    run: async (args, { services, principal }) => {
      const album = await services.albums.getWithAssets(principal.user.id, args.albumId as string)
      return json({
        id: album.id,
        name: album.name,
        description: album.description,
        // `album.assets` is capped at COVER_SAMPLE, not the whole album — `assetCount`
        // is the true total, the same figure `list_albums` above already reports.
        photoCount: album.assetCount,
        photos: album.assets.map(summarize),
      })
    },
  },

  {
    name: 'create_album',
    title: 'Create an album',
    description: 'Creates an album, optionally with photos in it.',
    scope: 'albums:write',
    input: z.object({
      name: z.string().min(1).max(256),
      description: z.string().max(4096).optional(),
      photoIds: z.array(z.string()).max(1000).optional(),
    }),
    run: async (args, { services, principal }) => {
      const album = await services.albums.create(principal.user.id, {
        name: args.name as string,
        ...(args.description ? { description: args.description as string } : {}),
        ...(args.photoIds ? { assetIds: args.photoIds as string[] } : {}),
      })
      return text(
        `Created the album "${album.name}" with ${album.assetCount} photos (id ${album.id}).`,
      )
    },
  },

  {
    name: 'add_to_album',
    title: 'Add photos to an album',
    description: 'Adds photos to an existing album. Photos already there are left alone.',
    scope: 'albums:write',
    input: z.object({
      albumId: z.string(),
      photoIds: z.array(z.string()).min(1).max(1000),
    }),
    run: async (args, { services, principal }) => {
      const result = await services.albums.addAssets(
        principal.user.id,
        args.albumId as string,
        args.photoIds as string[],
      )
      return text(
        `Added ${result.added} photo(s); ${result.skipped} were already there. ` +
          `The album now holds ${result.assetCount}.`,
      )
    },
  },

  {
    name: 'search_by_person',
    title: 'Find photos of a person',
    description:
      'Finds photos of a named person, for questions like "photos of Anna from last ' +
      'summer". Only people the owner has named are findable; unnamed groupings and ' +
      'anything in the vault are not visible here.',
    scope: 'library:read',
    input: z.object({
      name: z.string().min(1).describe('The person’s name, as the owner labelled them'),
      takenAfter: z.string().optional().describe('ISO 8601 date; only photos after it'),
      takenBefore: z.string().optional().describe('ISO 8601 date; only photos before it'),
      limit: z.number().int().min(1).max(100).default(25),
    }),
    run: async (args, { services, principal }) => {
      if (!(await services.faces.isEnabled())) {
        return text('Face grouping is switched off on this library.')
      }

      const matches = await services.faces.findPeopleByName(principal.user.id, args.name as string)
      if (matches.length === 0) {
        return text(`Nobody in this library is named "${args.name}".`)
      }
      if (matches.length > 1) {
        return text(
          `That matches more than one person: ${matches
            .map((m) => m.name)
            .join(', ')}. Ask again with the full name.`,
        )
      }

      const person = matches[0]!
      // photosOf already excludes vaulted and trashed photos.
      const photos = await services.faces.photosOf(principal.user.id, person.id, 500)

      const after = args.takenAfter ? new Date(args.takenAfter as string) : null
      const before = args.takenBefore ? new Date(args.takenBefore as string) : null
      const filtered = photos
        .filter((p) => (after ? p.capturedAt >= after : true))
        .filter((p) => (before ? p.capturedAt <= before : true))
        .sort((a, b) => b.capturedAt.getTime() - a.capturedAt.getTime())
        .slice(0, (args.limit as number) ?? 25)

      if (filtered.length === 0) {
        return text(`No photos of ${person.name} in that period.`)
      }
      return json({
        person: person.name,
        count: filtered.length,
        photos: filtered.map((p) => summarize(toAssetShape(p))),
      })
    },
  },

  {
    name: 'list_people',
    title: 'List people',
    description:
      'The named people in the library, with how many photos each appears in. Unnamed ' +
      'groupings and hidden people are not listed.',
    scope: 'library:read',
    input: z.object({}),
    run: async (_args, { services, principal }) => {
      if (!(await services.faces.isEnabled())) {
        return text('Face grouping is switched off on this library.')
      }
      const everyone = await services.faces.listPeople(principal.user.id)
      const named = everyone.filter((p) => p.name)
      if (named.length === 0) return text('Nobody in this library has been named yet.')
      return json(named.map((p) => ({ name: p.name, photoCount: p.faceCount })))
    },
  },

  {
    name: 'get_library_stats',
    title: 'Library statistics',
    description:
      'How many photos and videos there are, the date range they span, and storage used.',
    scope: 'library:read',
    input: z.object({}),
    run: async (_args, { services, principal }) => {
      const stats = await services.assets.stats(principal.user.id)
      return json({
        photos: stats.imageCount,
        videos: stats.videoCount,
        albums: stats.albumCount,
        favorites: stats.favoriteCount,
        inTrash: stats.trashedCount,
        storageUsed: formatBytes(stats.storageBytes),
        oldestPhoto: stats.earliestCapturedAt,
        newestPhoto: stats.latestCapturedAt,
      })
    },
  },
]

function formatBytes(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit++
  }
  return `${value.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`
}

/** The service returns database rows; summarize() expects the API shape. */
function toAssetShape(row: {
  id: string
  originalFilename: string
  type: string
  capturedAt: Date
  description: string | null
  favorite: boolean
  width: number | null
  height: number | null
  latitude: number | null
  longitude: number | null
  place: string | null
  exif: unknown
}) {
  return {
    id: row.id,
    originalFilename: row.originalFilename,
    type: row.type,
    capturedAt: row.capturedAt.toISOString(),
    description: row.description,
    favorite: row.favorite,
    width: row.width,
    height: row.height,
    location:
      row.latitude !== null && row.longitude !== null
        ? { latitude: row.latitude, longitude: row.longitude, place: row.place }
        : null,
    exif: row.exif as { make: string | null; model: string | null } | null,
  }
}

export const TOOLS_BY_NAME = new Map(TOOLS.map((t) => [t.name, t]))
