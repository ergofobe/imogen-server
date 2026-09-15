import { z } from '@hono/zod-openapi'
import { ApiError } from '@imogen/shared'

/** The response envelope every failing endpoint shares, described once. */
const errorContent = { 'application/json': { schema: ApiError } }

export const ERROR_RESPONSES = {
  400: { description: 'The request was malformed or failed validation', content: errorContent },
  401: { description: 'Authentication required', content: errorContent },
  403: { description: 'Authenticated, but not permitted', content: errorContent },
  404: { description: 'No such resource', content: errorContent },
} as const

export const CONFLICT_RESPONSE = {
  409: { description: 'Conflicts with existing state', content: errorContent },
} as const

export function ok<T extends z.ZodType>(schema: T, description: string) {
  return { 200: { description, content: { 'application/json': { schema } } } }
}

export function created<T extends z.ZodType>(schema: T, description: string) {
  return { 201: { description, content: { 'application/json': { schema } } } }
}

export const NO_CONTENT = {
  204: { description: 'Done. No body.' },
} as const

/**
 * Applied to every authenticated route so the OpenAPI document describes auth once.
 * A function, because each route needs its own mutable array.
 */
export const security = (): Array<Record<string, string[]>> => [
  { sessionCookie: [] },
  { oauth2: [] },
]

/**
 * A boolean as a query string can carry it, which is to say as text.
 *
 * `z.coerce.boolean()` reads such a field by JavaScript truthiness, where every string but
 * the empty one is true. So `"false"` — which is exactly what every SDK port writes, since
 * each one defaults the flag to false and then *sends* it — came back as `true`, and
 * `GET /people?includeHidden=false` answered with the hidden people. Somebody who hid a
 * person had them shown to every client anyway (imogen-server#100).
 *
 * The spelling is the contract instead. `1` and `0` are taken as well because they are the
 * other spelling a hand-written client reaches for; a native checkbox's own `on` is not,
 * since a form posting one would have to be told what `value` to send in any case. An
 * unrecognised spelling is refused rather than guessed at — a rejected request is a bug
 * report, a silently listed hidden person is not.
 *
 * This mirrors `WireBoolean` in `@imogen/shared`, which landed on imogen-sdk `main` after
 * the `v0.5.0` tag this repository is pinned to (imogen-sdk#36). It is a local copy only
 * because the two schemas that use it — `includeHidden` here and the vault's `covers` —
 * are declared in this repository, so the SDK's fix cannot reach them however the pin
 * moves. Kept identical so they can be swapped for the SDK's export once it is pinned,
 * without a behaviour change — including the JSON-shaped branches a query string cannot
 * itself produce.
 *
 * It does NOT cover this server's other wire booleans, which come from the pinned SDK and
 * are still `z.coerce.boolean()` at v0.5.0: `favorite`, `archived` and `trashed` on
 * `AssetFilter`, `covers` on `TimelineQuery` (so `GET /timeline` and the share timeline
 * disagree with `/vault/timeline` until the pin moves), and `AssetUploadMetadata.favorite`,
 * where an upload sent `favorite=false` is favourited. Those are fixed on SDK `main`; the
 * fix here is a pin move, which is its own PR. Do not paper over them by redeclaring the
 * SDK's fields locally — the contract lives in `@imogen/shared`, not here.
 *
 * No type is exported alongside it. Every branch that carries no opinion parses to
 * `undefined`, so the inferred type is `boolean | undefined` — a name a caller would
 * reasonably read as a plain boolean and be wrong about.
 */
export const WireBoolean = z
  .union(
    [
      z.boolean(),
      /*
       * The two ways a field arrives carrying no opinion: present but empty, which is how
       * `?covers=` comes from a link built with no query at all, and an explicit null. Both
       * parse to `undefined` — the same as never having been sent, rather than as `false`,
       * which for a filter means something of its own. Refusing them instead would turn a
       * link with an empty parameter into a 400.
       *
       * Note what `.default()` then does to that: zod re-applies a default to an `undefined`
       * *output*, not just to an absent input, so `WireBoolean.default(x)` reads an empty
       * value as `x`. That is why `includeHidden` defaults to `false` and not to `true` — a
       * `.default(true)` here would quietly turn `?flag=`, the case that carries no opinion,
       * into an opinion. Use `.optional()` where undefined has to survive.
       */
      z.literal('').transform(() => undefined),
      z.null().transform(() => undefined),
      z.enum(['true', 'false', '1', '0']).transform((value) => value === 'true' || value === '1'),
    ],
    // Zod's own union message is "Invalid input", which names none of the spellings it
    // would have taken. A refusal is only a bug report if it says what was expected.
    { error: 'expected true, false, 1 or 0' },
  )
  /*
   * The document keeps saying `boolean` while the parser stays strict. Without this the
   * generated `openapi.json` — a published artifact, and what the reference page and any
   * generated client read — advertises a four-branch `anyOf`, two branches of which a
   * query string cannot produce at all. A reader should not be told this parameter takes
   * JSON null.
   */
  .openapi({ type: 'boolean' })
