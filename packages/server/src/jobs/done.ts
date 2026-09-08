import { eq } from 'drizzle-orm'
import type { Database } from '../db/index.ts'
import { settings } from '../db/schema.ts'

/**
 * Whether a one-off pass over the library has finished. Keyed in `settings` so it runs
 * once per library, not once per boot.
 */
export async function isDone(db: Database, key: string): Promise<boolean> {
  const [row] = await db.select().from(settings).where(eq(settings.key, key)).limit(1)
  return row !== undefined
}

export async function markDone(db: Database, key: string): Promise<void> {
  await db
    .insert(settings)
    .values({ key, value: { done: true } })
    .onConflictDoUpdate({
      target: settings.key,
      set: { value: { done: true }, updatedAt: new Date() },
    })
}
