import { describe, expect, test } from 'bun:test'
import { replyTo } from './bridge.ts'

const json = (body: unknown, status: number) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })

// What the server sends when it refuses before parsing the body: it has no id to echo.
const refusal = () =>
  json(
    { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Authorization required' } },
    401,
  )

describe('deciding what to write back for a forwarded message', () => {
  test('answers a refused request with the id the agent asked under', async () => {
    const reply = (await replyTo({ id: 1 }, refusal())) as {
      jsonrpc: string
      id: unknown
      error: { message: string }
    }

    expect(reply.jsonrpc).toBe('2.0')
    expect(reply.id).toBe(1)
    expect(reply.error.message).toContain('imogen-mcp login')
  })

  test('keeps a string id, which JSON-RPC allows just as much as a number', async () => {
    const reply = (await replyTo({ id: 'init-1' }, refusal())) as { id: unknown }

    expect(reply.id).toBe('init-1')
  })

  test('keeps an id of 0, which is falsy but perfectly legal', async () => {
    const reply = (await replyTo({ id: 0 }, refusal())) as { id: unknown }

    expect(reply.id).toBe(0)
  })

  test('names the status for a failure that is not an authorization one', async () => {
    const reply = (await replyTo({ id: 2 }, json({ error: 'boom' }, 502))) as {
      id: unknown
      error: { code: number; message: string }
    }

    expect(reply.id).toBe(2)
    expect(reply.error.code).toBe(-32603)
    expect(reply.error.message).toContain('502')
  })

  test('stays silent when the request that failed was a notification', async () => {
    expect(await replyTo({}, refusal())).toBeUndefined()
    expect(await replyTo({ id: null }, refusal())).toBeUndefined()
  })

  test('stays silent for an accepted notification', async () => {
    expect(await replyTo({}, new Response(null, { status: 202 }))).toBeUndefined()
  })

  test('forwards a successful response as it came', async () => {
    const body = { jsonrpc: '2.0', id: 1, result: { tools: [] } }

    expect(await replyTo({ id: 1 }, json(body, 200))).toEqual(body)
  })

  test('answers rather than hangs when a request draws an empty body', async () => {
    // The same hang as a refusal, one branch over: a proxy answering for a dropped upstream,
    // or a 202 arriving for something that was not a notification.
    const reply = (await replyTo({ id: 3 }, new Response('', { status: 200 }))) as { id: unknown }

    expect(reply.id).toBe(3)
  })

  test('carries the server’s account of the failure so it is not lost', async () => {
    const body = { error: { code: 'bad_request', message: 'Request body is not valid JSON' } }
    const reply = (await replyTo({ id: 4 }, json(body, 400))) as { error: { data: string } }

    expect(reply.error.data).toContain('not valid JSON')
  })
})
