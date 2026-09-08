import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createApp } from './app.ts'
import { scheduleFaceRepair } from './jobs/faces.ts'
import { scheduleMaintenance } from './jobs/maintenance.ts'
import { loadConfig } from './lib/config.ts'
import { createServices } from './services.ts'

const config = loadConfig()
const services = createServices(config)

// The built web bundle sits next to the server in the container; in development the
// Vite dev server serves it instead, so its absence is expected.
const here = dirname(fileURLToPath(import.meta.url))
const webRoot = join(here, '../../web/dist')
const app = createApp({ services, ...(existsSync(webRoot) ? { webRoot } : {}) })

// A restart is the one moment we know for certain that nothing this process claimed is
// still running, so it is the natural place to recover what the last one left behind.
await services.queue.reclaimStale()

services.queue.start()
await scheduleMaintenance(services.queue)

// A library that lost faces before the server learned to clear them still carries them,
// and nothing re-scans a photograph already marked scanned. Runs once, then records that
// it has.
await scheduleFaceRepair(services.queue, services.db, services.faces)

const server = Bun.serve({
  port: config.port,
  // Home lab servers ingest 4K video; the default 128 MB body limit is not enough.
  maxRequestBodySize: 8 * 1024 * 1024 * 1024,
  idleTimeout: 255,
  fetch: app.fetch,
})

console.log(`imogen listening on http://localhost:${server.port}`)
console.log(`  API docs   ${config.publicUrl}/api/v1/docs`)
console.log(`  MCP        ${config.publicUrl}/mcp`)
if (!existsSync(webRoot)) console.log('  (web bundle not built; run bun run dev:web)')

async function shutdown(signal: string) {
  console.log(`\n${signal} received, shutting down`)
  await server.stop()
  await services.shutdown()
  process.exit(0)
}
process.on('SIGINT', () => void shutdown('SIGINT'))
process.on('SIGTERM', () => void shutdown('SIGTERM'))

/**
 * Say why the process is ending, whatever the reason.
 *
 * This server twice exited 0 in production while serving — no signal, no stack, the line
 * above never printed, and the jobs it had claimed were left `running` forever. An exit
 * that explains nothing is one nobody can fix, so: `beforeExit` distinguishes an event
 * loop that simply ran dry from a deliberate exit, and the two handlers below turn an
 * error that would otherwise leave silently into one that is written down first. Both
 * still end the process — this is instrumentation, not a safety net to keep running on.
 */
process.on('beforeExit', (code) => console.log(`event loop drained, exiting with ${code}`))
process.on('exit', (code) => console.log(`process exiting with code ${code}`))
process.on('uncaughtException', (error) => {
  console.error('uncaught exception', error)
  process.exit(1)
})
process.on('unhandledRejection', (reason) => {
  console.error('unhandled rejection', reason)
  process.exit(1)
})
