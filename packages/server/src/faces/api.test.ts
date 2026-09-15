import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { eq, sql } from 'drizzle-orm'
import sharp from 'sharp'
import { createApp } from '../app.ts'
import { people, users } from '../db/schema.ts'
import { createServices } from '../services.ts'
import { createTestConfig, createTestDatabase, removeTestConfig } from '../test/harness.ts'
import { ModelStore } from './models.ts'

process.env.NODE_ENV = 'test'

const harness = await createTestDatabase()
const config = createTestConfig({ publicUrl: 'http://localhost:3000' })
const services = createServices(config, harness.db)
const app = createApp({ services })

const MODELS =
  process.env.IMOGEN_TEST_MODELS ?? join(process.env.HOME ?? '', '.cache/imogen-test-models')
const FACES =
  process.env.IMOGEN_TEST_FACES ?? join(process.env.HOME ?? '', '.cache/imogen-test-faces')
const canRun = (await new ModelStore(MODELS).isReady()) && existsSync(join(FACES, 'person-a.png'))

// Point the running server at the fixture models rather than an empty data directory.
Object.assign(services, { models: new ModelStore(MODELS) })
;(services.faces as unknown as { models: ModelStore }).models = new ModelStore(MODELS)

afterAll(async () => {
  await harness.close()
  removeTestConfig(config)
})

beforeEach(async () => {
  await harness.db.execute(
    sql`truncate users, assets, faces, people, settings, oauth_clients, oauth_tokens, oauth_auth_codes, sessions cascade`,
  )
})

const request = (path: string, init: RequestInit = {}) =>
  app.fetch(new Request(`http://localhost:3000${path}`, init))

const json = (path: string, method: string, body: unknown, cookie?: string) =>
  request(path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
    body: JSON.stringify(body),
  })

async function signUp() {
  const response = await json('/api/v1/auth/signup', 'POST', {
    email: 'owner@example.com',
    password: 'a-sufficiently-long-password',
    name: 'Owner',
  })
  return response.headers.get('set-cookie')?.split(';')[0] ?? ''
}

/**
 * Uploads a portrait through the real API and processes it.
 *
 * `tweak` alters the pixels so two photographs of the same sitter are two assets:
 * identical bytes are deduplicated into one, which silently turns a two-photo test into
 * a one-photo test.
 */
async function uploadPortrait(cookie: string, fixture: string, name = fixture, tweak = 1) {
  const buffer = await sharp(join(FACES, fixture)).modulate({ brightness: tweak }).png().toBuffer()
  const form = new FormData()
  form.set('file', new File([new Uint8Array(buffer)], name, { type: 'image/png' }))
  const response = await request('/api/v1/assets', {
    method: 'POST',
    headers: { Cookie: cookie },
    body: form,
  })
  const { asset } = (await response.json()) as { asset: { id: string } }
  await services.queue.drain()
  return asset.id
}

async function enableFaces(cookie: string) {
  await json('/api/v1/people/enable', 'POST', { enabled: true }, cookie)
  // The enable path queues a model download; the fixtures are already present.
  await services.queue.drain()
}

describe.skipIf(!canRun)('turning the feature on', () => {
  test('it is off until somebody switches it on', async () => {
    const cookie = await signUp()

    const status = (await (
      await request('/api/v1/people/status', { headers: { Cookie: cookie } })
    ).json()) as { enabled: boolean }

    expect(status.enabled).toBe(false)
  })

  test('nothing is scanned while it is off', async () => {
    const cookie = await signUp()
    await uploadPortrait(cookie, 'person-a.png')

    const people = (await (
      await request('/api/v1/people', { headers: { Cookie: cookie } })
    ).json()) as { items: unknown[] }

    expect(people.items).toBeEmpty()
  })

  test('enabling it scans photos that were already there', async () => {
    const cookie = await signUp()
    await uploadPortrait(cookie, 'person-a.png')

    await enableFaces(cookie)

    const people = (await (
      await request('/api/v1/people', { headers: { Cookie: cookie } })
    ).json()) as { items: Array<{ photoCount: number }> }
    expect(people.items).toHaveLength(1)
    expect(people.items[0]!.photoCount).toBe(1)
  })

  test('a photo uploaded afterwards is scanned on arrival', async () => {
    const cookie = await signUp()
    await enableFaces(cookie)

    await uploadPortrait(cookie, 'person-b.png')

    const people = (await (
      await request('/api/v1/people', { headers: { Cookie: cookie } })
    ).json()) as { items: unknown[] }
    expect(people.items).toHaveLength(1)
  })
})

describe.skipIf(!canRun)('working with people', () => {
  async function libraryOfThree() {
    const cookie = await signUp()
    await enableFaces(cookie)
    for (const f of ['person-a.png', 'person-b.png', 'person-c.png']) {
      await uploadPortrait(cookie, f)
    }
    const people = (await (
      await request('/api/v1/people', { headers: { Cookie: cookie } })
    ).json()) as { items: Array<{ id: string; name: string | null }> }
    return { cookie, people: people.items }
  }

  test('lists everyone it has grouped', async () => {
    const { people } = await libraryOfThree()
    expect(people).toHaveLength(3)
  })

  test('names a person', async () => {
    const { cookie, people } = await libraryOfThree()

    const response = await json(
      `/api/v1/people/${people[0]!.id}`,
      'PATCH',
      { name: 'Anna' },
      cookie,
    )

    expect(response.status).toBe(204)
    const person = (await (
      await request(`/api/v1/people/${people[0]!.id}`, { headers: { Cookie: cookie } })
    ).json()) as { name: string; photos: unknown[] }
    expect(person.name).toBe('Anna')
    expect(person.photos).toHaveLength(1)
  })

  test('merges two clusters', async () => {
    const { cookie, people } = await libraryOfThree()

    const response = await json(
      '/api/v1/people/merge',
      'POST',
      { keepId: people[0]!.id, mergeIds: [people[1]!.id] },
      cookie,
    )

    expect(((await response.json()) as { moved: number }).moved).toBe(1)
    const after = (await (
      await request('/api/v1/people', { headers: { Cookie: cookie } })
    ).json()) as { items: unknown[] }
    expect(after.items).toHaveLength(2)
  })

  test('hides a person from the list', async () => {
    const { cookie, people } = await libraryOfThree()

    await json(`/api/v1/people/${people[0]!.id}`, 'PATCH', { hidden: true }, cookie)

    const visible = (await (
      await request('/api/v1/people', { headers: { Cookie: cookie } })
    ).json()) as { items: unknown[] }
    expect(visible.items).toHaveLength(2)
  })

  test('serves a face thumbnail', async () => {
    const { cookie, people } = await libraryOfThree()
    const person = (await (
      await request(`/api/v1/people/${people[0]!.id}`, { headers: { Cookie: cookie } })
    ).json()) as { coverFaceId: string }

    const response = await request(`/api/v1/people/thumbnail/${person.coverFaceId}`, {
      headers: { Cookie: cookie },
    })

    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('image/webp')
  })

  test('the faces in a photo come back with who they are', async () => {
    const { cookie, people } = await libraryOfThree()
    await json(`/api/v1/people/${people[0]!.id}`, 'PATCH', { name: 'Anna' }, cookie)

    const person = (await (
      await request(`/api/v1/people/${people[0]!.id}`, { headers: { Cookie: cookie } })
    ).json()) as { photos: Array<{ id: string }> }

    const faces = (await (
      await request(`/api/v1/people/faces/${person.photos[0]!.id}`, { headers: { Cookie: cookie } })
    ).json()) as { items: Array<{ personId: string; personName: string | null }> }

    expect(faces.items).toHaveLength(1)
    expect(faces.items[0]!.personName).toBe('Anna')
    expect(faces.items[0]!.personId).toBe(people[0]!.id)
  })

  test('an unnamed person is reported as unnamed rather than omitted', async () => {
    const { cookie, people } = await libraryOfThree()
    const person = (await (
      await request(`/api/v1/people/${people[0]!.id}`, { headers: { Cookie: cookie } })
    ).json()) as { photos: Array<{ id: string }> }

    const faces = (await (
      await request(`/api/v1/people/faces/${person.photos[0]!.id}`, { headers: { Cookie: cookie } })
    ).json()) as { items: Array<{ personId: string | null; personName: string | null }> }

    expect(faces.items[0]!.personName).toBeNull()
    expect(faces.items[0]!.personId).not.toBeNull()
  })

  test('another account cannot see them', async () => {
    const { people } = await libraryOfThree()
    const intruder = await json('/api/v1/auth/signup', 'POST', {
      email: 'intruder@example.com',
      password: 'a-sufficiently-long-password',
      name: 'Intruder',
    })
    const cookie = intruder.headers.get('set-cookie')?.split(';')[0] ?? ''

    const response = await request(`/api/v1/people/${people[0]!.id}`, {
      headers: { Cookie: cookie },
    })

    expect(response.status).toBe(403)
  })
})

describe.skipIf(!canRun)('the vault still holds', () => {
  async function vaultedLibrary() {
    const cookie = await signUp()
    await enableFaces(cookie)
    const shown = await uploadPortrait(cookie, 'person-a.png', 'shown.png')
    const secret = await uploadPortrait(cookie, 'person-b.png', 'secret.png')

    await json('/api/v1/vault/setup', 'POST', { passphrase: 'a-strong-vault-passphrase' }, cookie)
    const unlock = await json(
      '/api/v1/vault/unlock',
      'POST',
      { passphrase: 'a-strong-vault-passphrase' },
      cookie,
    )
    const both = `${cookie}; ${unlock.headers.get('set-cookie')?.split(';')[0] ?? ''}`
    await json('/api/v1/vault/assets', 'POST', { assetIds: [secret] }, both)
    return { cookie, both, shown, secret }
  }

  test('vaulting a photo removes the person it revealed', async () => {
    const { cookie } = await vaultedLibrary()

    const people = (await (
      await request('/api/v1/people', { headers: { Cookie: cookie } })
    ).json()) as { items: unknown[] }

    // The vaulted sitter appeared in no other photo, so they are gone entirely.
    expect(people.items).toHaveLength(1)
  })

  test('a vaulted photo is not among a person’s photos', async () => {
    const { cookie, secret } = await vaultedLibrary()

    const people = (await (
      await request('/api/v1/people', { headers: { Cookie: cookie } })
    ).json()) as { items: Array<{ id: string }> }
    const person = (await (
      await request(`/api/v1/people/${people.items[0]!.id}`, { headers: { Cookie: cookie } })
    ).json()) as { photos: Array<{ id: string }> }

    expect(person.photos.map((p) => p.id)).not.toContain(secret)
  })

  test('the faces of a vaulted photo are refused without the vault open', async () => {
    const { cookie, secret } = await vaultedLibrary()

    const response = await request(`/api/v1/people/faces/${secret}`, {
      headers: { Cookie: cookie },
    })

    expect(response.status).toBe(403)
  })
})

describe.skipIf(!canRun)('what an assistant can see', () => {
  async function connectorToken(cookie: string) {
    const client = (await (
      await json('/oauth/register', 'POST', {
        client_name: 'Claude',
        redirect_uris: ['https://claude.ai/api/mcp/auth_callback'],
        token_endpoint_auth_method: 'none',
      })
    ).json()) as { client_id: string }

    const { createHash, randomBytes } = await import('node:crypto')
    const verifier = randomBytes(32).toString('base64url')
    const challenge = createHash('sha256').update(verifier).digest('base64url')
    const params = new URLSearchParams({
      response_type: 'code',
      client_id: client.client_id,
      redirect_uri: 'https://claude.ai/api/mcp/auth_callback',
      code_challenge: challenge,
      code_challenge_method: 'S256',
      scope: 'library:read',
      approved: 'yes',
    })
    const approved = await request(`/oauth/authorize?${params}`, {
      headers: { Cookie: cookie },
      redirect: 'manual',
    })
    const code = new URL(approved.headers.get('location')!).searchParams.get('code')!
    const token = (await (
      await request('/oauth/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          client_id: client.client_id,
          code,
          code_verifier: verifier,
          redirect_uri: 'https://claude.ai/api/mcp/auth_callback',
        }),
      })
    ).json()) as { access_token: string }
    return token.access_token
  }

  const call = (token: string, name: string, args: Record<string, unknown>) =>
    request('/mcp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name, arguments: args },
      }),
    })

  const textOf = async (response: Response) => {
    const body = (await response.json()) as { result: { content: Array<{ text: string }> } }
    return body.result.content[0]!.text
  }

  test('finds photos of a named person', async () => {
    const cookie = await signUp()
    await enableFaces(cookie)
    await uploadPortrait(cookie, 'person-a.png', 'anna.png')
    const people = (await (
      await request('/api/v1/people', { headers: { Cookie: cookie } })
    ).json()) as { items: Array<{ id: string }> }
    await json(`/api/v1/people/${people.items[0]!.id}`, 'PATCH', { name: 'Anna' }, cookie)

    const token = await connectorToken(cookie)
    const said = await textOf(await call(token, 'search_by_person', { name: 'Anna' }))

    expect(said).toContain('anna.png')
  })

  test('says so plainly when nobody has that name', async () => {
    const cookie = await signUp()
    await enableFaces(cookie)
    const token = await connectorToken(cookie)

    const said = await textOf(await call(token, 'search_by_person', { name: 'Nobody' }))

    expect(said).toContain('Nobody in this library is named')
  })

  test('unnamed groupings are not findable', async () => {
    const cookie = await signUp()
    await enableFaces(cookie)
    await uploadPortrait(cookie, 'person-a.png')
    const token = await connectorToken(cookie)

    const said = await textOf(await call(token, 'list_people', {}))

    expect(said).toContain('has been named yet')
  })

  /** The one that matters most: a vaulted photo must not reach an assistant. */
  test('a vaulted photo never appears in a person’s results', async () => {
    const cookie = await signUp()
    await enableFaces(cookie)
    await uploadPortrait(cookie, 'person-a.png', 'shown.png')
    const secret = await uploadPortrait(cookie, 'person-a.png', 'secret.png', 1.15)

    const people = (await (
      await request('/api/v1/people', { headers: { Cookie: cookie } })
    ).json()) as { items: Array<{ id: string }> }
    await json(`/api/v1/people/${people.items[0]!.id}`, 'PATCH', { name: 'Anna' }, cookie)

    await json('/api/v1/vault/setup', 'POST', { passphrase: 'a-strong-vault-passphrase' }, cookie)
    const unlock = await json(
      '/api/v1/vault/unlock',
      'POST',
      { passphrase: 'a-strong-vault-passphrase' },
      cookie,
    )
    const both = `${cookie}; ${unlock.headers.get('set-cookie')?.split(';')[0] ?? ''}`
    await json('/api/v1/vault/assets', 'POST', { assetIds: [secret] }, both)

    const token = await connectorToken(cookie)
    const said = await textOf(await call(token, 'search_by_person', { name: 'Anna' }))

    expect(said).not.toContain('secret.png')
    expect(said).toContain('shown.png')
  })

  test('hidden people are invisible to an assistant', async () => {
    const cookie = await signUp()
    await enableFaces(cookie)
    await uploadPortrait(cookie, 'person-a.png')
    const people = (await (
      await request('/api/v1/people', { headers: { Cookie: cookie } })
    ).json()) as { items: Array<{ id: string }> }
    await json(
      `/api/v1/people/${people.items[0]!.id}`,
      'PATCH',
      { name: 'Anna', hidden: true },
      cookie,
    )

    const token = await connectorToken(cookie)
    const said = await textOf(await call(token, 'search_by_person', { name: 'Anna' }))

    expect(said).toContain('Nobody in this library is named')
  })

  test('the tools are silent while the feature is off', async () => {
    const cookie = await signUp()
    const token = await connectorToken(cookie)

    const said = await textOf(await call(token, 'search_by_person', { name: 'Anna' }))

    expect(said).toContain('switched off')
  })
})

/*
 * imogen-server#100. `includeHidden` was declared `z.coerce.boolean()`, which reads a
 * query parameter by JavaScript truthiness — where every string but the empty one is
 * true. So the string `"false"` arrived as `true`, and since every SDK port defaults
 * `includeHidden` to false and *sends* it, an ordinary `people.list()` carried
 * `?includeHidden=false` and was answered with the hidden people. Somebody who hid a
 * person had them shown to every client anyway, in the shipped v0.6.0.
 *
 * These seed the rows directly instead of going through the detector. Everything above
 * is skipped without the 190 MB face fixtures — which CI does not have, so none of it
 * runs there — and a privacy regression must not be able to hide behind a skip. What is
 * under test is how the query string is read, not how a face is found.
 */
describe('includeHidden is read by its spelling', () => {
  /** A library with one visible person and one hidden one, and no detector involved. */
  async function libraryOfTwo() {
    const cookie = await signUp()
    // By email rather than "the only row": a case that signs up twice would otherwise
    // seed these under whichever owner came back first, and fail somewhere unrelated.
    const [owner] = await harness.db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, 'owner@example.com'))
    await harness.db.insert(people).values([
      { ownerId: owner!.id, name: 'Visible', hidden: false, faceCount: 2 },
      { ownerId: owner!.id, name: 'Hidden', hidden: true, faceCount: 1 },
    ])
    return cookie
  }

  /** Who `GET /api/v1/people` names for a given query string, and the status it answered. */
  async function listedBy(query: string, cookie: string) {
    const response = await request(`/api/v1/people${query}`, { headers: { Cookie: cookie } })
    const body = (await response.json()) as { items?: Array<{ name: string }> }
    return { status: response.status, names: (body.items ?? []).map((p) => p.name) }
  }

  // The defect itself: this is the request every first-party client actually makes.
  test('includeHidden=false does not return a hidden person', async () => {
    const cookie = await libraryOfTwo()

    expect(await listedBy('?includeHidden=false', cookie)).toEqual({
      status: 200,
      names: ['Visible'],
    })
  })

  test('includeHidden=true returns them', async () => {
    const cookie = await libraryOfTwo()

    expect(await listedBy('?includeHidden=true', cookie)).toEqual({
      status: 200,
      names: ['Visible', 'Hidden'],
    })
  })

  test('omitting it keeps them hidden', async () => {
    const cookie = await libraryOfTwo()

    expect(await listedBy('', cookie)).toEqual({ status: 200, names: ['Visible'] })
  })

  // The other spelling a hand-written client reaches for.
  test('0 and 1 are read as false and true', async () => {
    const cookie = await libraryOfTwo()

    expect(await listedBy('?includeHidden=0', cookie)).toEqual({
      status: 200,
      names: ['Visible'],
    })
    expect(await listedBy('?includeHidden=1', cookie)).toEqual({
      status: 200,
      names: ['Visible', 'Hidden'],
    })
  })

  /*
   * Present but empty is how `?includeHidden=` arrives from a link built with no query at
   * all. It carries no opinion, so it reads as no value rather than as true — the safe
   * direction, and the one the SDK's own WireBoolean takes.
   */
  test('an empty value keeps them hidden', async () => {
    const cookie = await libraryOfTwo()

    expect(await listedBy('?includeHidden=', cookie)).toEqual({
      status: 200,
      names: ['Visible'],
    })
  })

  /*
   * Refused rather than guessed at. A rejected request is a bug report; a hidden person
   * quietly listed is not, which is exactly how this shipped.
   */
  test.each(['yes', 'no', 'on', 'off', 'True', 'FALSE', '2', '-1', 'null'])(
    'includeHidden=%s is refused',
    async (spelling) => {
      const cookie = await libraryOfTwo()

      expect((await listedBy(`?includeHidden=${spelling}`, cookie)).status).toBe(400)
    },
  )
})
