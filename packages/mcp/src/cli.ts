#!/usr/bin/env bun
import { rmSync } from 'node:fs'
import { OAuthClient } from '@imogen/sdk'
import { beginBridgeAuthorization } from './authorize.ts'
import { runBridge } from './bridge.ts'
import { credentialsPath, readCredentials, writeCredentials } from './credentials.ts'

const USAGE = `imogen-mcp — connect a local AI agent to your imogen photo library

  imogen-mcp login --server <url>   Authorize this machine (opens your browser)
  imogen-mcp logout                 Forget the saved session
  imogen-mcp status                 Show which library is connected
  imogen-mcp                        Run the MCP bridge on stdio

Add to an MCP client's configuration:

  {
    "mcpServers": {
      "imogen": { "command": "imogen-mcp" }
    }
  }
`

const [command, ...rest] = process.argv.slice(2)

switch (command) {
  case undefined:
    await bridge()
    break
  case 'login':
    await login(rest)
    break
  case 'logout':
    logout()
    break
  case 'status':
    status()
    break
  case '--help':
  case '-h':
  case 'help':
    process.stdout.write(USAGE)
    break
  default:
    process.stderr.write(`Unknown command: ${command}\n\n${USAGE}`)
    process.exit(1)
}

async function bridge() {
  const credentials = readCredentials()
  if (!credentials) {
    process.stderr.write('Not connected to a library. Run: imogen-mcp login --server <url>\n')
    process.exit(1)
  }
  await runBridge(credentials)
}

/**
 * Authorization code with PKCE against a loopback redirect, which is the flow RFC 8252
 * prescribes for a command-line tool: the browser handles the login, and the code comes
 * back to a server that exists only for the few seconds the flow takes.
 */
async function login(args: string[]) {
  const serverIndex = args.indexOf('--server')
  const server = serverIndex >= 0 ? args[serverIndex + 1] : args[0]
  if (!server) {
    process.stderr.write(
      'Which library? Example: imogen-mcp login --server https://photos.example.com\n',
    )
    process.exit(1)
  }

  const baseUrl = server.replace(/\/+$/, '')
  const oauth = new OAuthClient(baseUrl)

  const { promise, resolve, reject } = Promise.withResolvers<string>()
  const listener = Bun.serve({
    port: 0,
    fetch(request) {
      const url = new URL(request.url)
      if (url.pathname !== '/callback') return new Response('Not found', { status: 404 })
      resolve(request.url)
      return new Response(DONE_PAGE, { headers: { 'Content-Type': 'text/html' } })
    },
  })

  const redirectUri = `http://127.0.0.1:${listener.port}/callback`

  try {
    const { clientId, pending } = await beginBridgeAuthorization(oauth, redirectUri)

    process.stderr.write(`Opening your browser to authorize this machine.\n`)
    process.stderr.write(`If it does not open, visit:\n\n  ${pending.authorizationUrl}\n\n`)
    await openBrowser(pending.authorizationUrl)

    const timeout = setTimeout(
      () => reject(new Error('Timed out waiting for authorization')),
      300_000,
    )
    const callbackUrl = await promise
    clearTimeout(timeout)

    const tokens = await oauth.completeAuthorization(pending, callbackUrl)
    writeCredentials({ server: baseUrl, clientId, tokens })
    process.stderr.write(`Connected to ${baseUrl}.\nSaved to ${credentialsPath()}\n`)
  } catch (error) {
    process.stderr.write(`Authorization failed: ${(error as Error).message}\n`)
    process.exit(1)
  } finally {
    await listener.stop(true)
  }
}

function logout() {
  try {
    rmSync(credentialsPath(), { force: true })
    process.stderr.write('Signed out.\n')
  } catch {
    process.stderr.write('Nothing to sign out of.\n')
  }
}

function status() {
  const credentials = readCredentials()
  if (!credentials) {
    process.stdout.write('Not connected. Run: imogen-mcp login --server <url>\n')
    return
  }
  process.stdout.write(`Connected to ${credentials.server}\n`)
  process.stdout.write(`Scopes: ${credentials.tokens.scope}\n`)
  process.stdout.write(`Credentials: ${credentialsPath()}\n`)
}

async function openBrowser(url: string) {
  const command =
    process.platform === 'darwin'
      ? ['open', url]
      : process.platform === 'win32'
        ? ['cmd', '/c', 'start', '', url]
        : ['xdg-open', url]
  await Bun.spawn(command, { stdout: 'ignore', stderr: 'ignore' }).exited.catch(() => {})
}

const DONE_PAGE = `<!doctype html>
<meta charset="utf-8">
<title>Connected · imogen</title>
<style>
  body { margin:0; min-height:100vh; display:grid; place-items:center;
         font:16px/1.5 ui-sans-serif,-apple-system,sans-serif;
         background:#101113; color:#f2f3f4; }
  p { color:#9096a0; margin:.5rem 0 0; font-size:.925rem; }
  strong { font-weight:600; letter-spacing:-0.02em; font-size:1.25rem; }
</style>
<div style="text-align:center">
  <strong>Connected</strong>
  <p>You can close this tab and go back to your terminal.</p>
</div>`
