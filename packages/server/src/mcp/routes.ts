import type { Context } from 'hono'
import { Hono } from 'hono'
import { z } from 'zod'
import { type AppEnv, resolvePrincipal } from '../auth/middleware.ts'
import { HttpError } from '../lib/errors.ts'
import { TOOLS, TOOLS_BY_NAME, type ToolContext } from './tools.ts'

const PROTOCOL_VERSION = '2025-06-18'
const SUPPORTED_PROTOCOLS = ['2025-06-18', '2025-03-26', '2024-11-05']

const JsonRpcRequest = z.object({
  jsonrpc: z.literal('2.0'),
  id: z.union([z.string(), z.number()]).nullish(),
  method: z.string(),
  params: z.record(z.string(), z.unknown()).optional(),
})

const RPC = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
} as const

type Id = string | number | null

function result(id: Id, value: unknown) {
  return { jsonrpc: '2.0' as const, id, result: value }
}

function failure(id: Id, code: number, message: string, data?: unknown) {
  return { jsonrpc: '2.0' as const, id, error: { code, message, ...(data ? { data } : {}) } }
}

/**
 * MCP over Streamable HTTP.
 *
 * The spec allows a plain JSON response when a request needs no streaming, and none of
 * imogen's tools do — they answer in one shot. So this is a JSON-RPC endpoint rather than
 * an SSE session, which removes all the session bookkeeping without losing compatibility.
 *
 * Authorization is the OAuth 2.1 server: an unauthenticated request gets a 401 carrying
 * the resource-metadata pointer that Claude.ai and Grok follow to discover, register, and
 * complete a PKCE flow on their own.
 */
export function createMcpRoutes() {
  const app = new Hono<AppEnv>()

  app.all('/', async (c) => {
    const services = c.get('services')

    if (c.req.method === 'OPTIONS') {
      return c.body(null, 204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization, Mcp-Protocol-Version',
      })
    }

    // GET opens a server-initiated stream, which this server never needs.
    if (c.req.method === 'GET') return c.body(null, 405, { Allow: 'POST' })
    if (c.req.method !== 'POST') return c.body(null, 405, { Allow: 'POST' })

    const body = await c.req.json().catch(() => null)
    if (body === null) {
      return c.json(failure(null, RPC.PARSE_ERROR, 'Request body is not valid JSON'), 400)
    }

    // A batch is an array; answer each and drop notification responses.
    const isBatch = Array.isArray(body)
    const messages = isBatch ? body : [body]

    // This endpoint is its own protected resource, so a token minted for the REST API is
    // not a token for it. Anything the user consented to here was consented to for here.
    const principal = await resolvePrincipal(
      services,
      c.req.raw.headers,
      undefined,
      services.oauth.resourceIdentifier('/mcp'),
    )

    const responses = []
    for (const message of messages) {
      const parsed = JsonRpcRequest.safeParse(message)
      if (!parsed.success) {
        responses.push(failure(null, RPC.INVALID_REQUEST, 'Not a JSON-RPC 2.0 request'))
        continue
      }
      const request = parsed.data
      const id = request.id ?? null

      // Notifications get no response at all.
      if (request.id === undefined || request.id === null) {
        if (request.method.startsWith('notifications/')) continue
      }

      if (request.method === 'initialize') {
        const asked = (request.params?.protocolVersion as string) ?? PROTOCOL_VERSION
        responses.push(
          result(id, {
            protocolVersion: SUPPORTED_PROTOCOLS.includes(asked) ? asked : PROTOCOL_VERSION,
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: 'imogen', title: 'imogen photos', version: '0.1.0' },
            instructions:
              'This is the user’s personal photo library. Search with search_photos, then ' +
              'use get_photo_image to actually look at a photo. Ids come from search results.',
          }),
        )
        continue
      }

      if (request.method === 'ping') {
        responses.push(result(id, {}))
        continue
      }

      // Everything past this point touches the library, so it needs a caller.
      if (!principal) {
        return unauthorizedResponse(c, services.config.publicUrl)
      }

      if (request.method === 'tools/list') {
        responses.push(
          result(id, {
            tools: TOOLS.filter((t) => principal.scopes.includes(t.scope)).map((t) => ({
              name: t.name,
              title: t.title,
              description: t.description,
              inputSchema: z.toJSONSchema(t.input, { io: 'input' }),
            })),
          }),
        )
        continue
      }

      if (request.method === 'tools/call') {
        const name = request.params?.name
        if (typeof name !== 'string') {
          responses.push(failure(id, RPC.INVALID_PARAMS, 'A tool name is required'))
          continue
        }
        const tool = TOOLS_BY_NAME.get(name)
        if (!tool) {
          responses.push(failure(id, RPC.METHOD_NOT_FOUND, `No such tool: ${name}`))
          continue
        }
        if (!principal.scopes.includes(tool.scope)) {
          responses.push(
            failure(
              id,
              RPC.INVALID_REQUEST,
              `This connection was not granted the "${tool.scope}" permission`,
            ),
          )
          continue
        }

        const args = tool.input.safeParse(request.params?.arguments ?? {})
        if (!args.success) {
          responses.push(
            failure(
              id,
              RPC.INVALID_PARAMS,
              args.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
            ),
          )
          continue
        }

        const context: ToolContext = { services, principal }
        try {
          const output = await tool.run(args.data as Record<string, unknown>, context)
          responses.push(result(id, output))
        } catch (error) {
          // A tool failure is a result the model can read and react to, not a
          // protocol error that aborts the conversation.
          const message =
            error instanceof HttpError
              ? error.message
              : 'That did not work. Try a different request.'
          if (!(error instanceof HttpError)) console.error('mcp tool error', error)
          responses.push(result(id, { content: [{ type: 'text', text: message }], isError: true }))
        }
        continue
      }

      responses.push(failure(id, RPC.METHOD_NOT_FOUND, `Unsupported method: ${request.method}`))
    }

    if (responses.length === 0) return c.body(null, 202)
    return c.json(isBatch ? responses : responses[0], 200, {
      'Mcp-Protocol-Version': PROTOCOL_VERSION,
    })
  })

  return app
}

/**
 * RFC 9728: the 401 tells the client exactly where to go to get a token. Point at the
 * document nested under `/mcp`, which names this endpoint as the resource; the root
 * document names the site and leaves the client with nothing it can match.
 */
function unauthorizedResponse(c: Context<AppEnv>, publicUrl: string) {
  return c.json(failure(null, RPC.INVALID_REQUEST, 'Authorization required'), 401, {
    'WWW-Authenticate': `Bearer resource_metadata="${publicUrl}/.well-known/oauth-protected-resource/mcp"`,
  })
}
