import { z } from '@hono/zod-openapi'
import { ApiError, AssetFilter, AssetSelection } from '@imogen/shared'

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
 * This mirrors `WireBoolean` in `@imogen/shared` (imogen-sdk#36), which the pin now
 * carries, so the SDK-declared booleans — `favorite`, `archived` and `trashed` on
 * `AssetFilter`, `covers` on `TimelineQuery`, `AssetUploadMetadata.favorite` — read by
 * their spelling too. This copy survives that pin move rather than deferring to the
 * export, for two reasons, and both would be lost in the swap:
 *
 * - The custom union message. The SDK's is a bare `z.union`, so a refusal there reads
 *   "Invalid input", naming none of the spellings that would have worked. Zod cannot
 *   retrofit a message onto an already-built union, so keeping it means building the
 *   union here.
 * - The `.openapi({ type: 'boolean' })` below. The SDK carries no such annotation — it
 *   has no OpenAPI document to generate — and without it the published schema advertises
 *   a four-branch `anyOf`.
 *
 * The parse semantics are identical either way, which is the point: the two schemas that
 * use this — `includeHidden` here and the vault's `covers` — are declared in this
 * repository, and they must not disagree with the SDK's fields about what `false` means.
 * If the SDK ever grows the message and an annotation hook, this becomes a re-export. Do
 * not go the other way and redeclare the SDK's own fields here — the contract lives in
 * `@imogen/shared`, not here.
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

/**
 * The same annotation, for the wire booleans this repository does *not* declare.
 *
 * `WireBoolean` above can only carry `.openapi()` to the two fields declared here. The
 * SDK's own export is a bare union — it has no OpenAPI document to generate and so no
 * reason to annotate — so the moment the pin picked up imogen-sdk#36, `favorite`,
 * `archived` and `trashed` began publishing the four-branch `anyOf` that annotation
 * exists to suppress, while the vault's `covers` went on publishing `boolean`. One
 * concept, two shapes, in the same document.
 *
 * This re-annotates the SDK's own field schema rather than restating it: what is annotated
 * is whatever `schema.shape[key]` already holds, optionality and parsing included. That
 * matters — redeclaring these fields here would put a second copy of the contract in the
 * repository that does not own it, which is the thing the comment above forbids. Metadata
 * is not a declaration, and nothing about what the server accepts moves.
 *
 * `.meta()` and not `.openapi()`, which is the whole reason this is a function rather than
 * three call sites. `.openapi()` is not part of zod: `@hono/zod-openapi` patches it onto
 * the prototype when it is imported, so whether a schema built in *another* package has it
 * depends on whether that import happened to run first. It does under `bun run`, and it
 * does not part-way through a full `bun test`, where these same three fields threw
 * `field.openapi is not a function`. `.meta()` is zod's own, is always there, and produces
 * a byte-identical parameter schema.
 *
 * Named keys rather than sniffing the shape for unions: a guess at which fields are wire
 * booleans would quietly start annotating the wrong ones. The cost is that a wire boolean
 * added to the SDK later is not covered until it is named here, which is what the document
 * assertion in `app.test.ts` is for.
 */
export function documentWireBooleans<T extends z.ZodObject<z.ZodRawShape>>(
  schema: T,
  // Constrained to the schema's own keys, so an SDK that renames or drops one of these
  // fails `bun run verify` rather than booting a server that throws on the first route.
  ...keys: Array<keyof T['shape'] & string>
): T {
  const annotated = Object.fromEntries(
    keys.map((key) => {
      // `ZodObject`'s shape is typed as the base `$ZodType`, which is narrower than what
      // it actually holds; every field here is a full zod schema.
      const field = schema.shape[key] as z.ZodType | undefined
      if (!field) throw new Error(`documentWireBooleans: ${key} is not a field of this schema`)
      return [key, field.meta({ type: 'boolean' })]
    }),
  )
  return schema.extend(annotated) as unknown as T
}

/**
 * `AssetSelection` with the wire booleans of its nested filter annotated.
 *
 * The same three fields as the query routes, reached through `AssetSelection.query`,
 * which is `AssetFilter` — so without this the bodies of the six bulk-mutation routes
 * (assets trash and restore, the two album ones, the two vault ones) advertise `""`,
 * JSON null and `"0"`/`"1"` as spellings for a boolean in a *JSON* body, where a client
 * has real booleans to hand and should be told to write one.
 *
 * `.safeExtend()` and not `.extend()`: zod refuses the latter outright on an object
 * carrying refinements, and `AssetSelection` carries the one that enforces exactly one of
 * `assetIds` or `query`. The refinement survives `.safeExtend()` — verified against the
 * real schema before this was written, message included — which is the only reason this
 * is a safe thing to do to a contract schema rather than a rewrite of it.
 */
export const DocumentedAssetSelection = AssetSelection.safeExtend({
  query: documentWireBooleans(AssetFilter, 'favorite', 'archived', 'trashed').optional(),
})
