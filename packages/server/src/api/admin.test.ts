import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { sql } from 'drizzle-orm'
import { createApp } from '../app.ts'
import { jobs } from '../db/schema.ts'
import { FACE_MODELS_JOB } from '../jobs/faces.ts'
import { createServices } from '../services.ts'
import { createTestConfig, createTestDatabase, removeTestConfig } from '../test/harness.ts'

const harness = await createTestDatabase()
const config = createTestConfig({ publicUrl: 'http://localhost:3000' })
const services = createServices(config, harness.db)
const app = createApp({ services })

afterAll(async () => {
  await harness.close()
  removeTestConfig(config)
})

beforeEach(async () => {
  await harness.db.execute(
    sql`truncate users, assets, albums, jobs, sessions, invites, oauth_clients, oauth_tokens, share_links cascade`,
  )
})

const request = (path: string, init: RequestInit = {}) =>
  app.fetch(new Request(`http://localhost:3000${path}`, init))

async function signUp(email: string) {
  const response = await request('/api/v1/auth/signup', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: 'a-sufficiently-long-password', name: 'Someone' }),
  })
  const cookie = response.headers.get('set-cookie')?.split(';')[0] ?? ''
  return { cookie, user: (await response.json()) as { id: string; role: string } }
}

/**
 * The admin API is meant to be undiscoverable, not merely closed.
 *
 * Every refusal is a plain 404 carrying no hint that the route exists: a 401 or a 403
 * tells whoever is scanning that they have found the administration panel and only
 * need the right account, which is exactly what we are declining to tell them.
 */
describe('hiding the admin API', () => {
  test('an anonymous request is answered as though the route did not exist', async () => {
    const response = await request('/api/v1/admin/users')

    expect(response.status).toBe(404)
    const body = (await response.json()) as { error: { code: string } }
    expect(body.error.code).toBe('not_found')
  })

  test('a signed-in ordinary user gets the same nothing', async () => {
    await signUp('first@example.com')
    const { cookie, user } = await signUp('second@example.com')
    expect(user.role).toBe('user')

    const response = await request('/api/v1/admin/users', { headers: { Cookie: cookie } })

    expect(response.status).toBe(404)
  })

  test('a refusal never sends the header that advertises how to authenticate', async () => {
    const response = await request('/api/v1/admin/users')

    expect(response.headers.get('WWW-Authenticate')).toBeNull()
  })

  test('the refusal is word for word what an unrouted path returns', async () => {
    const hiddenPath = '/api/v1/admin/users'
    // Outside the admin router entirely, so this is what "nothing here" really sounds
    // like. Comparing two paths under /admin would compare the disguise with itself.
    const absentPath = '/api/v1/nowhere-at-all'

    const hidden = await request(hiddenPath)
    const absent = await request(absentPath)

    expect(hidden.status).toBe(absent.status)

    // Both name the path they were asked for, so they are compared with that one
    // difference taken out. Any wording of its own is the tell: it says something is
    // mounted here and declining, rather than nothing being mounted at all.
    const template = async (response: Response, path: string) =>
      JSON.parse(JSON.stringify(await response.json()).replaceAll(path, '{path}'))

    expect(await template(hidden, hiddenPath)).toEqual(await template(absent, absentPath))
  })

  test('the administrator gets through', async () => {
    const { cookie, user } = await signUp('first@example.com')
    expect(user.role).toBe('admin')

    const response = await request('/api/v1/admin/users', { headers: { Cookie: cookie } })

    expect(response.status).toBe(200)
  })
})

describe('listing accounts', () => {
  test('returns every account on the server, not only the caller', async () => {
    const { cookie } = await signUp('first@example.com')
    await signUp('second@example.com')

    const response = await request('/api/v1/admin/users', { headers: { Cookie: cookie } })
    const body = (await response.json()) as { items: Array<{ email: string; role: string }> }

    expect(body.items.map((u) => u.email).sort()).toEqual([
      'first@example.com',
      'second@example.com',
    ])
  })

  test('never includes anything that could unlock an account', async () => {
    const { cookie } = await signUp('first@example.com')

    const response = await request('/api/v1/admin/users', { headers: { Cookie: cookie } })
    const raw = await response.text()

    expect(raw).not.toContain('passwordHash')
    expect(raw).not.toContain('password_hash')
    expect(raw).not.toContain('vaultPassphraseHash')
  })
})

const asAdmin = (path: string, method: string, body?: unknown, cookie = '') =>
  request(path, {
    method,
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })

const login = (email: string) =>
  request('/api/v1/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: 'a-sufficiently-long-password' }),
  })

const signUpWithInvite = (email: string, token: string) =>
  request('/api/v1/auth/signup', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email,
      password: 'a-sufficiently-long-password',
      name: 'Invited',
      invite: token,
    }),
  })

describe('disabling an account', () => {
  test('a session issued before the account was disabled stops working at once', async () => {
    const admin = await signUp('first@example.com')
    const victim = await signUp('second@example.com')

    // Proven good first, so the assertion below cannot pass by accident.
    const before = await request('/api/v1/assets', { headers: { Cookie: victim.cookie } })
    expect(before.status).toBe(200)

    await asAdmin(
      `/api/v1/admin/users/${victim.user.id}`,
      'PATCH',
      { disabled: true },
      admin.cookie,
    )

    const after = await request('/api/v1/assets', { headers: { Cookie: victim.cookie } })
    expect(after.status).toBe(401)
  })

  /**
   * Disabling revokes the sessions that exist, which is what makes the browser stop
   * working. This checks the other half: a credential that outlives the revocation —
   * an OAuth bearer token, or a session minted in the same instant — is refused when
   * it is resolved, not merely absent. Without it the guard in the middleware is
   * covered only by the deletion happening to have swept the same rows.
   */
  test('a credential that survives the revocation is still refused', async () => {
    const admin = await signUp('first@example.com')
    const victim = await signUp('second@example.com')
    await asAdmin(
      `/api/v1/admin/users/${victim.user.id}`,
      'PATCH',
      { disabled: true },
      admin.cookie,
    )

    const revived = await services.sessions.create(victim.user.id, {})
    const response = await request('/api/v1/assets', {
      headers: { Cookie: `imogen_session=${revived.token}` },
    })

    expect(response.status).toBe(401)
  })

  test('a disabled account cannot sign in again', async () => {
    const admin = await signUp('first@example.com')
    const victim = await signUp('second@example.com')

    await asAdmin(
      `/api/v1/admin/users/${victim.user.id}`,
      'PATCH',
      { disabled: true },
      admin.cookie,
    )

    expect((await login('second@example.com')).status).toBeGreaterThanOrEqual(400)
  })

  test('enabling gives the account back', async () => {
    const admin = await signUp('first@example.com')
    const victim = await signUp('second@example.com')
    await asAdmin(
      `/api/v1/admin/users/${victim.user.id}`,
      'PATCH',
      { disabled: true },
      admin.cookie,
    )

    await asAdmin(
      `/api/v1/admin/users/${victim.user.id}`,
      'PATCH',
      { disabled: false },
      admin.cookie,
    )

    expect((await login('second@example.com')).status).toBe(200)
  })
})

describe('the last administrator', () => {
  test('cannot demote themselves and lock everyone out', async () => {
    const admin = await signUp('first@example.com')

    const response = await asAdmin(
      `/api/v1/admin/users/${admin.user.id}`,
      'PATCH',
      { role: 'user' },
      admin.cookie,
    )

    expect(response.status).toBe(409)
  })

  test('cannot disable themselves either', async () => {
    const admin = await signUp('first@example.com')

    const response = await asAdmin(
      `/api/v1/admin/users/${admin.user.id}`,
      'PATCH',
      { disabled: true },
      admin.cookie,
    )

    expect(response.status).toBe(409)
  })

  test('may step down once somebody else can take over', async () => {
    const admin = await signUp('first@example.com')
    const other = await signUp('second@example.com')
    await asAdmin(`/api/v1/admin/users/${other.user.id}`, 'PATCH', { role: 'admin' }, admin.cookie)

    const response = await asAdmin(
      `/api/v1/admin/users/${admin.user.id}`,
      'PATCH',
      { role: 'user' },
      admin.cookie,
    )

    expect(response.status).toBe(200)
  })

  test('a disabled administrator does not count as cover', async () => {
    const admin = await signUp('first@example.com')
    const other = await signUp('second@example.com')
    await asAdmin(`/api/v1/admin/users/${other.user.id}`, 'PATCH', { role: 'admin' }, admin.cookie)
    await asAdmin(`/api/v1/admin/users/${other.user.id}`, 'PATCH', { disabled: true }, admin.cookie)

    const response = await asAdmin(
      `/api/v1/admin/users/${admin.user.id}`,
      'PATCH',
      { role: 'user' },
      admin.cookie,
    )

    expect(response.status).toBe(409)
  })
})

describe('invitations', () => {
  test('the link is shown once and is not recoverable afterwards', async () => {
    const admin = await signUp('first@example.com')

    const created = await asAdmin('/api/v1/admin/invites', 'POST', {}, admin.cookie)
    const invite = (await created.json()) as { token: string; id: string }
    expect(invite.token).toBeTruthy()

    const listed = await request('/api/v1/admin/invites', { headers: { Cookie: admin.cookie } })

    expect(await listed.text()).not.toContain(invite.token)
  })

  test('lets somebody in while public sign-up stays shut', async () => {
    const admin = await signUp('first@example.com')
    const created = await asAdmin('/api/v1/admin/invites', 'POST', {}, admin.cookie)
    const { token } = (await created.json()) as { token: string }

    expect((await signUpWithInvite('invited@example.com', token)).status).toBe(200)
  })

  test('one invitation admits exactly one person', async () => {
    const admin = await signUp('first@example.com')
    const created = await asAdmin('/api/v1/admin/invites', 'POST', {}, admin.cookie)
    const { token } = (await created.json()) as { token: string }

    expect((await signUpWithInvite('one@example.com', token)).status).toBe(200)
    expect((await signUpWithInvite('two@example.com', token)).status).toBeGreaterThanOrEqual(400)
  })

  test('an invitation addressed to someone is refused to anybody else', async () => {
    const admin = await signUp('first@example.com')
    const created = await asAdmin(
      '/api/v1/admin/invites',
      'POST',
      { email: 'wanted@example.com' },
      admin.cookie,
    )
    const { token } = (await created.json()) as { token: string }

    expect(
      (await signUpWithInvite('someone-else@example.com', token)).status,
    ).toBeGreaterThanOrEqual(400)
    expect((await signUpWithInvite('wanted@example.com', token)).status).toBe(200)
  })

  test('an invitation can hand over administration', async () => {
    const admin = await signUp('first@example.com')
    const created = await asAdmin('/api/v1/admin/invites', 'POST', { role: 'admin' }, admin.cookie)
    const { token } = (await created.json()) as { token: string }

    const response = await signUpWithInvite('deputy@example.com', token)
    const user = (await response.json()) as { role: string }

    expect(user.role).toBe('admin')
  })

  test('an expired invitation is refused', async () => {
    const admin = await signUp('first@example.com')
    const created = await asAdmin('/api/v1/admin/invites', 'POST', {}, admin.cookie)
    const { token, id } = (await created.json()) as { token: string; id: string }

    await harness.db.execute(
      sql`update invites set expires_at = now() - interval '1 hour' where id = ${id}`,
    )

    expect((await signUpWithInvite('late@example.com', token)).status).toBeGreaterThanOrEqual(400)
  })

  test('a revoked invitation is refused', async () => {
    const admin = await signUp('first@example.com')
    const created = await asAdmin('/api/v1/admin/invites', 'POST', {}, admin.cookie)
    const { token, id } = (await created.json()) as { token: string; id: string }

    await asAdmin(`/api/v1/admin/invites/${id}`, 'DELETE', undefined, admin.cookie)

    expect((await signUpWithInvite('revoked@example.com', token)).status).toBeGreaterThanOrEqual(
      400,
    )
  })

  test('a made-up token is refused', async () => {
    await signUp('first@example.com')

    expect((await signUpWithInvite('chancer@example.com', 'imog_inv_nonsense')).status).toBe(403)
  })
})

describe('deleting an account', () => {
  test('the photographs go to the trash rather than being destroyed', async () => {
    const admin = await signUp('first@example.com')
    const victim = await signUp('second@example.com')
    await harness.db.execute(
      sql`insert into assets (owner_id, type, status, original_filename, mime_type, checksum, size_bytes, original_path, captured_at)
          values (${victim.user.id}, 'image', 'ready', 'x.jpg', 'image/jpeg', ${'a'.repeat(64)}, 10, 'x/1.jpg', now())`,
    )

    await asAdmin(`/api/v1/admin/users/${victim.user.id}`, 'DELETE', undefined, admin.cookie)

    const rows = await harness.db.execute(
      sql`select count(*)::int as n from assets where owner_id = ${victim.user.id} and deleted_at is not null`,
    )
    expect((rows[0] as { n: number }).n).toBe(1)
  })

  test('the account stops being able to sign in', async () => {
    const admin = await signUp('first@example.com')
    const victim = await signUp('second@example.com')

    await asAdmin(`/api/v1/admin/users/${victim.user.id}`, 'DELETE', undefined, admin.cookie)

    expect((await login('second@example.com')).status).toBeGreaterThanOrEqual(400)
  })

  test('its session dies with it', async () => {
    const admin = await signUp('first@example.com')
    const victim = await signUp('second@example.com')
    expect((await request('/api/v1/assets', { headers: { Cookie: victim.cookie } })).status).toBe(
      200,
    )

    await asAdmin(`/api/v1/admin/users/${victim.user.id}`, 'DELETE', undefined, admin.cookie)

    const after = await request('/api/v1/assets', { headers: { Cookie: victim.cookie } })
    expect(after.status).toBe(401)
  })

  test('the account is gone from the list even though the row survives for the sweep', async () => {
    const admin = await signUp('first@example.com')
    const victim = await signUp('second@example.com')

    await asAdmin(`/api/v1/admin/users/${victim.user.id}`, 'DELETE', undefined, admin.cookie)

    const listed = await request('/api/v1/admin/users', { headers: { Cookie: admin.cookie } })
    const body = (await listed.json()) as { items: Array<{ email: string }> }
    expect(body.items.map((u) => u.email)).toEqual(['first@example.com'])
  })

  test('the last administrator cannot delete themselves', async () => {
    const admin = await signUp('first@example.com')

    const response = await asAdmin(
      `/api/v1/admin/users/${admin.user.id}`,
      'DELETE',
      undefined,
      admin.cookie,
    )

    expect(response.status).toBe(409)
  })
})

describe('the work queue', () => {
  const addJob = (status: string, error: string | null = null, attempts = 0) =>
    harness.db.execute(
      sql`insert into jobs (name, payload, status, attempts, max_attempts, last_error)
          values ('media.process', '{}'::jsonb, ${status}, ${attempts}, 5, ${error})
          returning id`,
    )

  test('reports what is waiting, running and broken', async () => {
    const admin = await signUp('first@example.com')
    await addJob('queued')
    await addJob('queued')
    await addJob('running')
    await addJob('failed', 'ffmpeg fell over')

    const response = await request('/api/v1/admin/queue', { headers: { Cookie: admin.cookie } })
    const body = (await response.json()) as {
      queued: number
      running: number
      failed: number
      failures: Array<{ lastError: string | null }>
    }

    expect(body.queued).toBe(2)
    expect(body.running).toBe(1)
    expect(body.failed).toBe(1)
    expect(body.failures[0]?.lastError).toBe('ffmpeg fell over')
  })

  test('retrying puts a failure back in the queue with its attempts cleared', async () => {
    const admin = await signUp('first@example.com')
    const rows = await addJob('failed', 'ffmpeg fell over', 5)
    const id = (rows[0] as { id: string }).id

    const response = await asAdmin(`/api/v1/admin/queue/${id}/retry`, 'POST', {}, admin.cookie)
    expect(response.status).toBe(204)

    const after = await harness.db.execute(
      sql`select status, attempts, last_error from jobs where id = ${id}`,
    )
    const job = after[0] as { status: string; attempts: number; last_error: string | null }
    expect(job.status).toBe('queued')
    // Left at the limit it would be picked up and abandoned again on the first error.
    expect(job.attempts).toBe(0)
  })

  test('retrying everything picks up only the failures', async () => {
    const admin = await signUp('first@example.com')
    await addJob('failed', 'one')
    await addJob('failed', 'two')
    await addJob('done')

    await asAdmin('/api/v1/admin/queue/retry', 'POST', {}, admin.cookie)

    const rows = await harness.db.execute(
      sql`select status, count(*)::int as n from jobs group by status`,
    )
    const byStatus = Object.fromEntries(
      (rows as Array<{ status: string; n: number }>).map((r) => [r.status, r.n]),
    )
    expect(byStatus.queued).toBe(2)
    expect(byStatus.done).toBe(1)
    expect(byStatus.failed).toBeUndefined()
  })

  test('discarding a failure removes it', async () => {
    const admin = await signUp('first@example.com')
    const rows = await addJob('failed', 'hopeless')
    const id = (rows[0] as { id: string }).id

    await asAdmin(`/api/v1/admin/queue/${id}`, 'DELETE', undefined, admin.cookie)

    const after = await harness.db.execute(
      sql`select count(*)::int as n from jobs where id = ${id}`,
    )
    expect((after[0] as { n: number }).n).toBe(0)
  })

  test('the queue is not readable by an ordinary account', async () => {
    await signUp('first@example.com')
    const { cookie } = await signUp('second@example.com')

    const response = await request('/api/v1/admin/queue', { headers: { Cookie: cookie } })

    expect(response.status).toBe(404)
  })
})

describe('apps and sessions', () => {
  test('lists sessions and marks the one making the request', async () => {
    const admin = await signUp('first@example.com')
    await signUp('second@example.com')

    const response = await request('/api/v1/admin/sessions', { headers: { Cookie: admin.cookie } })
    const body = (await response.json()) as {
      items: Array<{ current: boolean; userEmail: string }>
    }

    expect(body.items).toHaveLength(2)
    const mine = body.items.filter((s) => s.current)
    expect(mine).toHaveLength(1)
    expect(mine[0]?.userEmail).toBe('first@example.com')
  })

  test('revoking a session ends it at once', async () => {
    const admin = await signUp('first@example.com')
    const other = await signUp('second@example.com')
    expect((await request('/api/v1/assets', { headers: { Cookie: other.cookie } })).status).toBe(
      200,
    )

    const listed = await request('/api/v1/admin/sessions', { headers: { Cookie: admin.cookie } })
    const { items } = (await listed.json()) as { items: Array<{ id: string; current: boolean }> }
    const theirs = items.find((s) => !s.current)

    await asAdmin(`/api/v1/admin/sessions/${theirs?.id}`, 'DELETE', undefined, admin.cookie)

    const after = await request('/api/v1/assets', { headers: { Cookie: other.cookie } })
    expect(after.status).toBe(401)
  })

  test('an administrator cannot revoke the session they are using', async () => {
    const admin = await signUp('first@example.com')
    const listed = await request('/api/v1/admin/sessions', { headers: { Cookie: admin.cookie } })
    const { items } = (await listed.json()) as { items: Array<{ id: string; current: boolean }> }
    const mine = items.find((s) => s.current)

    const response = await asAdmin(
      `/api/v1/admin/sessions/${mine?.id}`,
      'DELETE',
      undefined,
      admin.cookie,
    )

    expect(response.status).toBe(409)
  })

  test('lists registered applications and says which registered themselves', async () => {
    const admin = await signUp('first@example.com')
    await harness.db.execute(
      sql`insert into oauth_clients (id, name, redirect_uris, grant_types, scopes, dynamically_registered)
          values ('some-app', 'Some App', '["myapp://cb"]'::jsonb, '["authorization_code"]'::jsonb, '["library:read"]'::jsonb, true)`,
    )

    const response = await request('/api/v1/admin/clients', { headers: { Cookie: admin.cookie } })
    const body = (await response.json()) as {
      items: Array<{ id: string; dynamicallyRegistered: boolean; isPublic: boolean }>
    }

    const app = body.items.find((c) => c.id === 'some-app')
    expect(app?.dynamicallyRegistered).toBe(true)
    expect(app?.isPublic).toBe(true)
  })

  test('revoking an application takes its tokens with it', async () => {
    const admin = await signUp('first@example.com')
    await harness.db.execute(
      sql`insert into oauth_clients (id, name, redirect_uris, grant_types, scopes)
          values ('doomed', 'Doomed', '["myapp://cb"]'::jsonb, '["authorization_code"]'::jsonb, '["library:read"]'::jsonb)`,
    )
    await harness.db.execute(
      sql`insert into oauth_tokens (token_hash, kind, client_id, user_id, scopes, family_id, expires_at)
          values ('deadbeef', 'access', 'doomed', ${admin.user.id}, '["library:read"]'::jsonb, gen_random_uuid(), now() + interval '1 hour')`,
    )

    await asAdmin('/api/v1/admin/clients/doomed', 'DELETE', undefined, admin.cookie)

    const left = await harness.db.execute(
      sql`select count(*)::int as n from oauth_tokens where client_id = 'doomed'`,
    )
    expect((left[0] as { n: number }).n).toBe(0)
  })

  test('none of it is readable by an ordinary account', async () => {
    await signUp('first@example.com')
    const { cookie } = await signUp('second@example.com')

    expect((await request('/api/v1/admin/clients', { headers: { Cookie: cookie } })).status).toBe(
      404,
    )
    expect((await request('/api/v1/admin/sessions', { headers: { Cookie: cookie } })).status).toBe(
      404,
    )
  })
})

describe('server settings', () => {
  const trySignup = (email: string) =>
    request('/api/v1/auth/signup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password: 'a-sufficiently-long-password', name: 'Someone' }),
    })

  test('closing sign-up takes effect without a restart', async () => {
    const admin = await signUp('first@example.com')
    // Proven open first, so the assertion below cannot pass for the wrong reason.
    expect((await trySignup('early@example.com')).status).toBe(200)

    await asAdmin('/api/v1/admin/settings', 'PATCH', { allowSignup: false }, admin.cookie)

    expect((await trySignup('late@example.com')).status).toBe(403)
  })

  test('opening it again lets people in', async () => {
    const admin = await signUp('first@example.com')
    await asAdmin('/api/v1/admin/settings', 'PATCH', { allowSignup: false }, admin.cookie)
    await asAdmin('/api/v1/admin/settings', 'PATCH', { allowSignup: true }, admin.cookie)

    expect((await trySignup('welcome@example.com')).status).toBe(200)
  })

  test('an invitation still works while sign-up is closed', async () => {
    const admin = await signUp('first@example.com')
    await asAdmin('/api/v1/admin/settings', 'PATCH', { allowSignup: false }, admin.cookie)
    const created = await asAdmin('/api/v1/admin/invites', 'POST', {}, admin.cookie)
    const { token } = (await created.json()) as { token: string }

    expect((await signUpWithInvite('invited@example.com', token)).status).toBe(200)
  })

  test('the login page is told what the stored setting says', async () => {
    const admin = await signUp('first@example.com')
    await asAdmin('/api/v1/admin/settings', 'PATCH', { allowSignup: false }, admin.cookie)

    const response = await request('/api/v1/auth/config')
    const body = (await response.json()) as { allowSignup: boolean }

    expect(body.allowSignup).toBe(false)
  })

  /**
   * The people page has its own switch, and for a while only that one scheduled the
   * download — a server enabled from here reported face grouping as on with no models
   * on disk and no job that would ever fetch them.
   */
  test('switching face grouping on from here queues the model download', async () => {
    const admin = await signUp('first@example.com')

    await asAdmin('/api/v1/admin/settings', 'PATCH', { facesEnabled: true }, admin.cookie)

    const queued = await harness.db.select().from(jobs)
    expect(queued.map((job) => job.name)).toEqual([FACE_MODELS_JOB])

    await asAdmin('/api/v1/admin/settings', 'PATCH', { facesEnabled: false }, admin.cookie)
  })

  test('settings are not readable by an ordinary account', async () => {
    await signUp('first@example.com')
    const { cookie } = await signUp('second@example.com')

    const response = await request('/api/v1/admin/settings', { headers: { Cookie: cookie } })

    expect(response.status).toBe(404)
  })
})

describe('storage', () => {
  test('reports the retention window and what is in the trash', async () => {
    const admin = await signUp('first@example.com')
    await harness.db.execute(
      sql`insert into assets (owner_id, type, status, original_filename, mime_type, checksum, size_bytes, original_path, captured_at, deleted_at)
          values (${admin.user.id}, 'image', 'ready', 'gone.jpg', 'image/jpeg', ${'b'.repeat(64)}, 2048, 'x/2.jpg', now(), now())`,
    )

    const response = await request('/api/v1/admin/storage', { headers: { Cookie: admin.cookie } })
    const body = (await response.json()) as {
      trashedCount: number
      trashedBytes: number
      trashRetentionDays: number
      perUser: Array<{ email: string }>
    }

    expect(body.trashedCount).toBe(1)
    expect(body.trashedBytes).toBe(2048)
    expect(body.trashRetentionDays).toBeGreaterThan(0)
    expect(body.perUser.map((u) => u.email)).toContain('first@example.com')
  })
})

describe('public links', () => {
  const addShare = async (ownerId: string, slug: string, expired = false) => {
    const rows = await harness.db.execute(
      sql`insert into assets (owner_id, type, status, original_filename, mime_type, checksum, size_bytes, original_path, captured_at)
          values (${ownerId}, 'image', 'ready', ${`${slug}.jpg`}, 'image/jpeg', ${slug.padEnd(64, '0')}, 10, ${`x/${slug}.jpg`}, now())
          returning id`,
    )
    const assetId = (rows[0] as { id: string }).id
    await harness.db.execute(
      sql`insert into share_links (slug, asset_id, created_by, expires_at)
          values (${slug}, ${assetId}, ${ownerId},
                  ${expired ? sql`now() - interval '1 day'` : sql`null`})`,
    )
  }

  test('lists what is public and says who shared it', async () => {
    const admin = await signUp('first@example.com')
    await addShare(admin.user.id, 'abcdef')

    const response = await request('/api/v1/admin/shares', { headers: { Cookie: admin.cookie } })
    const body = (await response.json()) as {
      items: Array<{ slug: string; kind: string; createdByEmail: string; target: string }>
    }

    expect(body.items).toHaveLength(1)
    expect(body.items[0]?.kind).toBe('photo')
    expect(body.items[0]?.createdByEmail).toBe('first@example.com')
    expect(body.items[0]?.target).toBe('abcdef.jpg')
  })

  test('a link that has run out is not counted as public', async () => {
    const admin = await signUp('first@example.com')
    await addShare(admin.user.id, 'expired', true)

    const response = await request('/api/v1/admin/shares', { headers: { Cookie: admin.cookie } })
    const body = (await response.json()) as { items: unknown[] }

    expect(body.items).toHaveLength(0)
  })

  test('closing a link stops it working for everyone', async () => {
    const admin = await signUp('first@example.com')
    await addShare(admin.user.id, 'closeme')
    expect((await request('/api/v1/share/closeme')).status).toBe(200)

    const listed = await request('/api/v1/admin/shares', { headers: { Cookie: admin.cookie } })
    const { items } = (await listed.json()) as { items: Array<{ id: string }> }
    await asAdmin(`/api/v1/admin/shares/${items[0]?.id}`, 'DELETE', undefined, admin.cookie)

    expect((await request('/api/v1/share/closeme')).status).toBe(404)
  })

  test('an ordinary account cannot see what everyone has shared', async () => {
    await signUp('first@example.com')
    const { cookie } = await signUp('second@example.com')

    expect((await request('/api/v1/admin/shares', { headers: { Cookie: cookie } })).status).toBe(
      404,
    )
  })
})
