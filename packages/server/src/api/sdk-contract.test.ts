import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { type FetchLike, ImogenClient, ImogenError, OAuthClient } from '@imogen/sdk'
import { sql } from 'drizzle-orm'
import sharp from 'sharp'
import { createApp } from '../app.ts'
import { createServices } from '../services.ts'
import { createTestConfig, createTestDatabase, removeTestConfig } from '../test/harness.ts'

process.env.NODE_ENV = 'test'

const harness = await createTestDatabase()
const config = createTestConfig({ publicUrl: 'http://localhost:3000' })
const services = createServices(config, harness.db)
const app = createApp({ services })

/**
 * The published client, exercised against the real server.
 *
 * This test used to live in the SDK, and moved here when the SDK moved out. It belongs on
 * this side of the split: the conformance suite in imogen-sdk pins down what the client
 * sends, and nothing there can prove the server answers it. That is this file's job, and
 * it needs a server to do it.
 */
const cookieJar: string[] = []
const testFetch: FetchLike = async (input, init) => {
  const request = new Request(input as RequestInfo, init)
  if (cookieJar.length > 0) request.headers.set('Cookie', cookieJar.join('; '))
  const response = await app.fetch(request)
  const setCookie = response.headers.get('set-cookie')
  if (setCookie) {
    const pair = setCookie.split(';')[0]!
    const name = pair.split('=')[0]
    const index = cookieJar.findIndex((c) => c.startsWith(`${name}=`))
    if (index >= 0) cookieJar[index] = pair
    else cookieJar.push(pair)
  }
  return response
}

const client = new ImogenClient({ baseUrl: 'http://localhost:3000', fetch: testFetch })

afterAll(async () => {
  await harness.close()
  removeTestConfig(config)
})

beforeEach(async () => {
  cookieJar.length = 0
  await harness.db.execute(
    sql`truncate users, assets, albums, oauth_clients, oauth_tokens, oauth_auth_codes, jobs, sessions, upload_sessions cascade`,
  )
})

async function photo(name = 'photo.jpg', size = 800): Promise<File> {
  const seed = [...name].reduce((acc, ch) => (acc * 31 + ch.charCodeAt(0)) % 251, 7)
  const buffer = await sharp({
    create: {
      width: size,
      height: Math.round(size * 0.75),
      channels: 3,
      background: { r: seed, g: (seed * 3) % 256, b: (seed * 7) % 256 },
    },
  })
    .jpeg()
    .toBuffer()
  return new File([new Uint8Array(buffer)], name, { type: 'image/jpeg' })
}

async function signUp() {
  return client.auth.signup({
    email: 'owner@example.com',
    password: 'a-sufficiently-long-password',
    name: 'Owner',
  })
}

describe('connecting', () => {
  test('reports server health', async () => {
    expect(await client.health()).toMatchObject({ status: 'ok' })
  })

  test('reads sign-in options before anyone has an account', async () => {
    const config = await client.auth.config()

    expect(config.needsSetup).toBe(true)
    expect(config.oidc.enabled).toBe(false)
  })

  test('signs up, then reports the signed-in user', async () => {
    const created = await signUp()

    const me = await client.auth.me()

    expect(me.id).toBe(created.id)
    expect(me.role).toBe('admin')
  })
})

describe('errors', () => {
  test('turns a rejection into a typed error, not a bare Response', async () => {
    const error = await client.auth.me().catch((e) => e)

    expect(error).toBeInstanceOf(ImogenError)
    expect((error as ImogenError).status).toBe(401)
    expect((error as ImogenError).isAuthError).toBe(true)
  })

  test('surfaces field-level validation detail', async () => {
    const error = (await client.auth
      .signup({ email: 'nope', password: 'short', name: '' })
      .catch((e) => e)) as ImogenError

    expect(error.code).toBe('validation_failed')
    expect(error.details?.email).toBeDefined()
  })

  test('does not retry a rejection the server will keep rejecting', async () => {
    let calls = 0
    const counting = new ImogenClient({
      baseUrl: 'http://localhost:3000',
      fetch: (input, init) => {
        calls++
        return testFetch(input, init)
      },
    })

    await counting.auth.me().catch(() => {})

    expect(calls).toBe(1)
  })
})

describe('uploading', () => {
  test('uploads a photo and reads it back', async () => {
    await signUp()

    const { asset, duplicate } = await client.assets.upload(await photo())
    await services.queue.drain()

    expect(duplicate).toBe(false)
    const fetched = await client.assets.get(asset.id)
    expect(fetched.status).toBe('ready')
    expect(fetched.width).toBe(800)
  })

  test('reports progress', async () => {
    await signUp()
    const events: number[] = []

    await client.assets.upload(await photo(), {
      onProgress: (p) => events.push(p.loaded),
    })

    expect(events.at(-1)).toBeGreaterThan(0)
  })

  test('recognises a duplicate instead of storing it twice', async () => {
    await signUp()
    const file = await photo()
    const first = await client.assets.upload(file)

    const second = await client.assets.upload(file)

    expect(second.duplicate).toBe(true)
    expect(second.asset.id).toBe(first.asset.id)
  })

  test('uploads many files with bounded concurrency', async () => {
    await signUp()
    const files = await Promise.all(
      Array.from({ length: 9 }, (_, i) => photo(`bulk-${i}.jpg`, 200)),
    )

    const results = await client.assets.uploadMany(files, { concurrency: 3 })

    expect(results).toHaveLength(9)
    expect(results.every((r) => r.result && !r.error)).toBe(true)
  })

  test('one bad file does not abandon the rest of a bulk upload', async () => {
    await signUp()
    const files = [
      await photo('good-1.jpg', 200),
      new File(['not an image'], 'broken.pdf', { type: 'application/pdf' }),
      await photo('good-2.jpg', 200),
    ]

    const results = await client.assets.uploadMany(files, { concurrency: 2 })

    expect(results.filter((r) => r.result)).toHaveLength(2)
    expect(results.filter((r) => r.error)).toHaveLength(1)
    expect(results[1]!.error).toBeInstanceOf(ImogenError)
  })

  test('reports each file as it settles so a UI can update incrementally', async () => {
    await signUp()
    const files = await Promise.all(Array.from({ length: 4 }, (_, i) => photo(`p-${i}.jpg`, 200)))
    const seen: number[] = []

    await client.assets.uploadMany(files, {
      concurrency: 2,
      onFileComplete: (_outcome, completed, total) => {
        seen.push(completed)
        expect(total).toBe(4)
      },
    })

    expect(seen.sort()).toEqual([1, 2, 3, 4])
  })
})

describe('browsing', () => {
  async function library() {
    await signUp()
    const files = await Promise.all(
      Array.from({ length: 12 }, (_, i) => photo(`shot-${i}.jpg`, 200)),
    )
    await client.assets.uploadMany(files, { concurrency: 4 })
    await services.queue.drain()
  }

  test('lists a page of assets', async () => {
    await library()

    const page = await client.assets.list({ limit: 5 })

    expect(page.items).toHaveLength(5)
    expect(page.nextCursor).toBeString()
  })

  test('iterates the whole library exactly once', async () => {
    await library()
    const seen: string[] = []

    for await (const asset of client.assets.iterate({ limit: 5 })) seen.push(asset.id)

    expect(seen).toHaveLength(12)
    expect(new Set(seen).size).toBe(12)
  })

  test('searches by filename', async () => {
    await library()

    const page = await client.assets.list({ q: 'shot-3' })

    expect(page.items).toHaveLength(1)
    expect(page.items[0]!.originalFilename).toBe('shot-3.jpg')
  })

  test('marks a photo as a favourite', async () => {
    await library()
    const page = await client.assets.list({ limit: 1 })

    const updated = await client.assets.update(page.items[0]!.id, { favorite: true })

    expect(updated.favorite).toBe(true)
    expect((await client.assets.list({ favorite: true })).items).toHaveLength(1)
  })

  test('trashing hides a photo, restoring brings it back', async () => {
    await library()
    const page = await client.assets.list({ limit: 1 })
    const id = page.items[0]!.id

    await client.assets.trash([id])
    const afterTrash = await client.assets.list({ limit: 100 })

    await client.assets.restore([id])
    const afterRestore = await client.assets.list({ limit: 100 })

    expect(afterTrash.items).toHaveLength(11)
    expect(afterRestore.items).toHaveLength(12)
  })

  test('builds a usable image URL', async () => {
    await library()
    const page = await client.assets.list({ limit: 1 })

    const url = client.assets.urlFor(page.items[0]!.id, 'thumbnail')

    expect(url).toBe(`http://localhost:3000/api/v1/assets/${page.items[0]!.id}/thumbnail`)
    expect((await testFetch(url)).status).toBe(200)
  })

  test('fetches image bytes directly', async () => {
    await library()
    const page = await client.assets.list({ limit: 1 })

    const blob = await client.assets.blob(page.items[0]!.id, 'preview')

    expect(blob.size).toBeGreaterThan(0)
    expect(blob.type).toBe('image/webp')
  })

  test('summarises the library', async () => {
    await library()

    const stats = await client.assets.stats()

    expect(stats.assetCount).toBe(12)
    expect(stats.imageCount).toBe(12)
    expect(stats.storageBytes).toBeGreaterThan(0)
  })
})

describe('albums', () => {
  test('creates an album containing photos', async () => {
    await signUp()
    const a = await client.assets.upload(await photo('a.jpg', 200))
    const b = await client.assets.upload(await photo('b.jpg', 200))
    await services.queue.drain()

    const album = await client.albums.create({
      name: 'Holiday',
      assetIds: [a.asset.id, b.asset.id],
    })

    expect(album.assetCount).toBe(2)
    expect((await client.albums.get(album.id)).assets).toHaveLength(2)
  })

  test('shares an album and revokes the link', async () => {
    await signUp()
    const uploaded = await client.assets.upload(await photo('a.jpg', 200))
    await services.queue.drain()
    const album = await client.albums.create({ name: 'Shared', assetIds: [uploaded.asset.id] })

    const link = await client.albums.share(album.id)
    expect(link.url).toContain('/share/')
    expect((await testFetch(`http://localhost:3000/api/v1/share/${link.slug}`)).status).toBe(200)

    await client.albums.unshare(album.id)
    expect((await testFetch(`http://localhost:3000/api/v1/share/${link.slug}`)).status).toBe(404)
  })

  test('deleting an album leaves its photos in the library', async () => {
    await signUp()
    const uploaded = await client.assets.upload(await photo('a.jpg', 200))
    await services.queue.drain()
    const album = await client.albums.create({ name: 'Temp', assetIds: [uploaded.asset.id] })

    await client.albums.remove(album.id)

    expect(await client.albums.list()).toBeEmpty()
    expect((await client.assets.list()).items).toHaveLength(1)
  })
})

describe('OAuth client', () => {
  const oauth = new OAuthClient('http://localhost:3000', testFetch)

  test('discovers the authorization server', async () => {
    const metadata = await oauth.discover()

    expect(metadata.issuer).toBe('http://localhost:3000')
    expect(metadata.code_challenge_methods_supported).toContain('S256')
  })

  test('registers a public client with no secret', async () => {
    const registered = await oauth.register('My Photo App', ['myapp://oauth'])

    expect(registered.client_id).toBeString()
    expect(registered.client_secret).toBeUndefined()
  })

  test('runs a full PKCE flow and returns a usable token', async () => {
    await signUp()
    const uploaded = await client.assets.upload(await photo('a.jpg', 200))
    await services.queue.drain()

    const registered = await oauth.register('My Photo App', ['myapp://oauth'])
    const pending = await oauth.beginAuthorization(registered.client_id, 'myapp://oauth', [
      'library:read',
    ])

    // The system browser would do this; here we approve directly.
    const approved = await testFetch(`${pending.authorizationUrl}&approved=yes`, {
      redirect: 'manual',
    })
    const callbackUrl = approved.headers.get('location')!

    const tokens = await oauth.completeAuthorization(pending, callbackUrl)
    expect(tokens.access_token).toBeString()
    expect(OAuthClient.isExpired(tokens)).toBe(false)

    // A fresh client using only the token, with no cookie at all.
    const tokenClient = new ImogenClient({
      baseUrl: 'http://localhost:3000',
      token: tokens.access_token,
      fetch: async (input, init) => app.fetch(new Request(input as RequestInfo, init)),
    })
    const page = await tokenClient.assets.list()
    expect(page.items[0]!.id).toBe(uploaded.asset.id)
  })

  test('refuses a callback whose state does not match', async () => {
    const registered = await oauth.register('My Photo App', ['myapp://oauth'])
    const pending = await oauth.beginAuthorization(registered.client_id, 'myapp://oauth')

    const promise = oauth.completeAuthorization(
      pending,
      'myapp://oauth?code=stolen&state=someone-elses-state',
    )

    await expect(promise).rejects.toThrow('state did not match')
  })

  test('surfaces a denial from the authorization server', async () => {
    const registered = await oauth.register('My Photo App', ['myapp://oauth'])
    const pending = await oauth.beginAuthorization(registered.client_id, 'myapp://oauth')

    const promise = oauth.completeAuthorization(
      pending,
      'myapp://oauth?error=access_denied&error_description=The+user+declined',
    )

    await expect(promise).rejects.toThrow('The user declined')
  })

  test('refreshes an access token', async () => {
    await signUp()
    const registered = await oauth.register('My Photo App', ['myapp://oauth'])
    const pending = await oauth.beginAuthorization(registered.client_id, 'myapp://oauth', [
      'library:read',
    ])
    const approved = await testFetch(`${pending.authorizationUrl}&approved=yes`, {
      redirect: 'manual',
    })
    const tokens = await oauth.completeAuthorization(pending, approved.headers.get('location')!)

    const refreshed = await oauth.refresh(registered.client_id, tokens.refresh_token!)

    expect(refreshed.access_token).not.toBe(tokens.access_token)
  })
})
