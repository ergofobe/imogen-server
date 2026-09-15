ALTER TABLE "assets" ADD COLUMN "content_hash_scheme" integer;--> statement-breakpoint
--
-- Scheme 1 is the rule every stored hash was produced by: the file that computes it,
-- packages/server/src/media/content-hash.ts, has exactly one commit in its history
-- (d74d064) and first shipped in v0.6.0, so no library can hold a hash from any other
-- rule. Stamping those rows is what keeps this migration from re-reading every original
-- in the library to learn what it already knows.
--
-- Rows with no hash keep a null scheme and stay on the backfill's list, which is what a
-- library upgrading from before the column needs -- claiming those had been hashed would
-- mean they never are.
--
-- This rewrites every hashed row and holds their locks until it commits, so a large
-- library waits on it before the server comes up. It is still the cheap end of the
-- choice: the alternative is the backfill reading every original off disk to learn what
-- this statement already knows.
--
UPDATE "assets" SET "content_hash_scheme" = 1 WHERE "content_hash" IS NOT NULL;--> statement-breakpoint
--
-- The walk's bookkeeping stops being a boolean. `{"done": true}` meant "this library is
-- hashed, for ever", which is the whole of #86; it becomes the scheme the completed walk
-- covered, so the next rule change schedules one more pass instead of nothing.
--
UPDATE "settings" SET "key" = 'assets.contentHashScheme', "value" = '{"scheme": 1}' WHERE "key" = 'assets.contentHashBackfillDone';
