import { type Credentials, currentAccessToken } from './credentials.ts'

/**
 * A stdio-to-HTTP bridge.
 *
 * Claude.ai and Grok connect to imogen's `/mcp` endpoint directly. A local agent that
 * only speaks stdio cannot, so this process sits between them: it reads newline-delimited
 * JSON-RPC from stdin, forwards each message to the remote endpoint with a bearer token,
 * and writes the reply to stdout. The token is refreshed here rather than in the agent,
 * so a long conversation never fails because an hour elapsed.
 */
export async function runBridge(credentials: Credentials): Promise<void> {
  const endpoint = `${credentials.server}/mcp`

  const send = (message: unknown) => {
    process.stdout.write(`${JSON.stringify(message)}\n`)
  }

  const forward = async (message: { id?: unknown; method?: string }) => {
    try {
      const token = await currentAccessToken(credentials)
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(message),
      })

      const reply = await replyTo(message, response)
      if (reply !== undefined) send(reply)
    } catch (error) {
      if (message.id === undefined || message.id === null) return
      send({
        jsonrpc: '2.0',
        id: message.id,
        error: { code: -32603, message: (error as Error).message },
      })
    }
  }

  const decoder = new TextDecoder()
  let buffer = ''

  const reader = Bun.stdin.stream().getReader()
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })

    // Messages are newline-delimited; a partial line stays in the buffer until it completes.
    let newline = buffer.indexOf('\n')
    while (newline >= 0) {
      const line = buffer.slice(0, newline).trim()
      buffer = buffer.slice(newline + 1)
      newline = buffer.indexOf('\n')
      if (!line) continue

      let message: { id?: unknown; method?: string }
      try {
        message = JSON.parse(line)
      } catch {
        send({
          jsonrpc: '2.0',
          id: null,
          error: { code: -32700, message: 'Parse error' },
        })
        continue
      }

      // Deliberately not awaited: a slow tool call must not block the next message.
      void forward(message)
    }
  }
}

/**
 * The reply to write for one forwarded message, or `undefined` when the agent expects none.
 *
 * Split out of `forward` so it can be tested without a live stdin: the loop above could take
 * a `ReadableStream` instead, but parameterising it buys nothing when every decision worth
 * protecting is in here.
 *
 * A JSON-RPC batch is out of scope. A line that parses to an array has no top-level `id`, so
 * it takes the notification path below and its replies are dropped; the bridge has never
 * assembled a batch response, and the server only sees batches from clients that negotiate a
 * protocol version predating their removal.
 */
export async function replyTo(message: { id?: unknown }, response: Response): Promise<unknown> {
  // A notification gets no reply, and neither does its forwarded form — including when the
  // forward was refused, which is why this stays ahead of every check on the response.
  if (message.id === undefined || message.id === null) return

  const text = (await response.text()).trim()

  // Past this point the agent is waiting for an answer under `message.id`, and every path has
  // to produce one. The server refuses before parsing the body, so its own error carries
  // `id: null` — correct on the wire, and unmatchable by the agent, which then waits forever
  // instead of reporting the refusal. An empty body is the same hang by another route: a 202
  // meant for a notification, or a proxy answering for an upstream it dropped.
  if (!response.ok || !text) {
    return {
      jsonrpc: '2.0',
      id: message.id,
      error: {
        code: -32603,
        message:
          response.status === 401
            ? 'imogen rejected the stored credentials. Run: imogen-mcp login --server <url>'
            : `imogen returned HTTP ${response.status}`,
        // The server's own account of the failure, which is otherwise lost: an error body is
        // `{ error: { code, message } }`, not a JSON-RPC message, so it cannot be re-idded and
        // passed through — but it is the only thing that says *which* request was rejected.
        ...(text ? { data: text.slice(0, 500) } : {}),
      },
    }
  }

  return JSON.parse(text)
}
