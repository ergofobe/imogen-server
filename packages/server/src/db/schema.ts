import { sql } from 'drizzle-orm'
import {
  bigint,
  boolean,
  check,
  customType,
  doublePrecision,
  index,
  integer,
  pgTable,
  primaryKey,
  real,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  vector,
} from 'drizzle-orm/pg-core'

/** Postgres full-text search vector. Drizzle has no native tsvector column type. */
const tsvector = customType<{ data: string; driverData: string }>({
  dataType: () => 'tsvector',
})

/**
 * Bun's SQL driver already serializes objects bound to a json/jsonb parameter. Drizzle's
 * built-in `jsonb` stringifies first, so the value lands as a JSON *string* containing
 * JSON: `jsonb_typeof` reports "string" and `->>` returns null. It round-trips through
 * Drizzle because the decode is symmetric, which hides the damage from tests that only
 * read back through the ORM — but the generated search vector and every external reader
 * see the wrong thing. Passing the value through untouched is the fix.
 */
const json = <T>(name: string) =>
  customType<{ data: T; driverData: T }>({
    dataType: () => 'jsonb',
    toDriver: (value: T) => value,
  })(name)

const createdAt = timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
const updatedAt = timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()

export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    email: text('email').notNull(),
    name: text('name').notNull(),
    role: text('role', { enum: ['admin', 'user'] })
      .notNull()
      .default('user'),
    /** Null for accounts that authenticate only through OIDC. */
    passwordHash: text('password_hash'),
    oidcSubject: text('oidc_subject'),
    avatarUrl: text('avatar_url'),
    /**
     * The vault's own passphrase, separate from the account password on purpose: SSO
     * users have no local password, and a borrowed unlocked session should not open it.
     */
    vaultPassphraseHash: text('vault_passphrase_hash'),
    /** Throttles guessing. Cleared on a successful unlock. */
    vaultFailedAttempts: integer('vault_failed_attempts').notNull().default(0),
    vaultLockedUntil: timestamp('vault_locked_until', { withTimezone: true }),
    /**
     * Set when an administrator takes access away without deleting the account.
     * Checked wherever a caller is resolved, not only at sign-in: a session issued
     * before the account was disabled must stop working at once.
     */
    disabledAt: timestamp('disabled_at', { withTimezone: true }),
    /**
     * Set when the account is deleted. A tombstone rather than a removed row: the
     * photographs are on their way to the trash sweep and they cascade from here, so
     * dropping the row now would destroy immediately what is meant to be recoverable.
     * The sweep removes the row once the last of its assets has gone.
     */
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    quotaBytes: bigint('quota_bytes', { mode: 'number' }),
    usedBytes: bigint('used_bytes', { mode: 'number' }).notNull().default(0),
    createdAt,
    updatedAt,
  },
  (t) => [
    uniqueIndex('users_email_key').on(sql`lower(${t.email})`),
    uniqueIndex('users_oidc_subject_key')
      .on(t.oidcSubject)
      .where(sql`${t.oidcSubject} is not null`),
  ],
)

export const sessions = pgTable(
  'sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** SHA-256 of the opaque token. The token itself is never stored. */
    tokenHash: text('token_hash').notNull(),
    userAgent: text('user_agent'),
    ipAddress: text('ip_address'),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }).notNull().defaultNow(),
    createdAt,
  },
  (t) => [
    uniqueIndex('sessions_token_hash_key').on(t.tokenHash),
    index('sessions_user_id_idx').on(t.userId),
  ],
)

export const assets = pgTable(
  'assets',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    type: text('type', { enum: ['image', 'video'] }).notNull(),
    status: text('status', { enum: ['pending', 'processing', 'ready', 'failed'] })
      .notNull()
      .default('pending'),
    originalFilename: text('original_filename').notNull(),
    mimeType: text('mime_type').notNull(),
    checksum: text('checksum').notNull(),
    sizeBytes: bigint('size_bytes', { mode: 'number' }).notNull(),
    /** Path relative to the library root, so the data directory can move. */
    originalPath: text('original_path').notNull(),
    width: integer('width'),
    height: integer('height'),
    duration: real('duration'),
    capturedAt: timestamp('captured_at', { withTimezone: true }).notNull(),
    capturedAtIsExact: boolean('captured_at_is_exact').notNull().default(false),
    /**
     * The capture date before the owner corrected it, so a correction can be undone.
     *
     * Null until the first correction. We never rewrite the uploaded file, so the
     * camera's own EXIF is always intact on disk — but nothing else in the row
     * remembers the date it gave us once `captured_at` has been written over.
     */
    capturedAtOriginal: timestamp('captured_at_original', { withTimezone: true }),
    /** Whether that imported date was itself exact, so a revert restores the label too. */
    capturedAtOriginalIsExact: boolean('captured_at_original_is_exact'),
    favorite: boolean('favorite').notNull().default(false),
    archived: boolean('archived').notNull().default(false),
    description: text('description'),
    exif: json<Record<string, unknown>>('exif'),
    latitude: doublePrecision('latitude'),
    longitude: doublePrecision('longitude'),
    altitude: doublePrecision('altitude'),
    place: text('place'),
    placeholderColor: text('placeholder_color'),
    livePhotoVideoId: uuid('live_photo_video_id'),
    deviceAssetId: text('device_asset_id'),
    /** Reserved for CLIP embeddings; stays null until the optional ML sidecar exists. */
    embedding: vector('embedding', { dimensions: 512 }),
    /**
     * Maintained by Postgres, so a description edit cannot forget to reindex.
     * Weights put the filename and description above camera and place.
     */
    searchVector: tsvector('search_vector').generatedAlwaysAs(
      // Postgres indexes "harbour-sunset.jpg" as a single `file` token, so searching for
      // "harbour" would miss it. Replacing punctuation with spaces first makes every part
      // of a filename findable, which is how people actually search for their photos.
      sql`setweight(to_tsvector('simple', translate(coalesce(original_filename, ''), '._-/\\', '     ')), 'A') ||
          setweight(to_tsvector('english', coalesce(description, '')), 'A') ||
          setweight(to_tsvector('simple', coalesce(place, '')), 'B') ||
          setweight(to_tsvector('simple', coalesce(exif->>'make', '') || ' ' || coalesce(exif->>'model', '')), 'C')`,
    ),
    /** Non-null means the asset lives in the vault and is hidden from everything else. */
    vaultedAt: timestamp('vaulted_at', { withTimezone: true }),
    /**
     * When this photo was last looked at for faces. Recorded whether or not any were
     * found, because "has no faces row" would otherwise mean "never scanned" forever
     * for every landscape in the library.
     */
    facesScannedAt: timestamp('faces_scanned_at', { withTimezone: true }),
    processingError: text('processing_error'),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    createdAt,
    updatedAt,
  },
  (t) => [
    // Re-uploading a file you already have is a no-op, not a duplicate row.
    uniqueIndex('assets_owner_checksum_key').on(t.ownerId, t.checksum),
    uniqueIndex('assets_owner_device_asset_key')
      .on(t.ownerId, t.deviceAssetId)
      .where(sql`${t.deviceAssetId} is not null`),
    // The timeline's only hot query: owner's live assets, newest first, tie-broken by id.
    index('assets_timeline_idx')
      .on(t.ownerId, t.capturedAt.desc(), t.id.desc())
      .where(sql`${t.deletedAt} is null and ${t.vaultedAt} is null`),
    index('assets_vault_idx')
      .on(t.ownerId, t.capturedAt.desc(), t.id.desc())
      .where(sql`${t.vaultedAt} is not null`),
    index('assets_owner_status_idx').on(t.ownerId, t.status),
    index('assets_faces_pending_idx')
      .on(t.ownerId)
      .where(
        sql`${t.facesScannedAt} is null and ${t.deletedAt} is null and ${t.vaultedAt} is null`,
      ),
    index('assets_deleted_at_idx').on(t.deletedAt).where(sql`${t.deletedAt} is not null`),
    index('assets_search_idx').using('gin', t.searchVector),
    index('assets_location_idx')
      .on(t.ownerId, t.latitude, t.longitude)
      .where(sql`${t.latitude} is not null`),
  ],
)

export const assetFiles = pgTable(
  'asset_files',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    assetId: uuid('asset_id')
      .notNull()
      .references(() => assets.id, { onDelete: 'cascade' }),
    variant: text('variant', { enum: ['original', 'preview', 'thumbnail'] }).notNull(),
    path: text('path').notNull(),
    mimeType: text('mime_type').notNull(),
    sizeBytes: bigint('size_bytes', { mode: 'number' }).notNull(),
    width: integer('width'),
    height: integer('height'),
    createdAt,
  },
  (t) => [uniqueIndex('asset_files_asset_variant_key').on(t.assetId, t.variant)],
)

export const albums = pgTable(
  'albums',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    description: text('description'),
    coverAssetId: uuid('cover_asset_id').references(() => assets.id, { onDelete: 'set null' }),
    createdAt,
    updatedAt,
  },
  (t) => [index('albums_owner_idx').on(t.ownerId, t.updatedAt.desc())],
)

export const albumAssets = pgTable(
  'album_assets',
  {
    albumId: uuid('album_id')
      .notNull()
      .references(() => albums.id, { onDelete: 'cascade' }),
    assetId: uuid('asset_id')
      .notNull()
      .references(() => assets.id, { onDelete: 'cascade' }),
    position: integer('position').notNull().default(0),
    addedAt: timestamp('added_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.albumId, t.assetId] }),
    index('album_assets_asset_idx').on(t.assetId),
    index('album_assets_order_idx').on(t.albumId, t.position),
  ],
)

export const shareLinks = pgTable(
  'share_links',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    slug: text('slug').notNull(),
    /**
     * A link points at exactly one thing. Both columns are nullable and a check
     * constraint keeps precisely one set, so "an album or a photograph" is a rule the
     * database holds rather than one every query has to remember.
     */
    albumId: uuid('album_id').references(() => albums.id, { onDelete: 'cascade' }),
    assetId: uuid('asset_id').references(() => assets.id, { onDelete: 'cascade' }),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    passwordHash: text('password_hash'),
    allowDownload: boolean('allow_download').notNull().default(true),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    createdAt,
  },
  (t) => [
    uniqueIndex('share_links_slug_key').on(t.slug),
    index('share_links_album_idx').on(t.albumId),
    index('share_links_asset_idx').on(t.assetId),
    check('share_links_one_target', sql`(album_id is null) <> (asset_id is null)`),
  ],
)

// --- OAuth 2.1 authorization server ---

export const oauthClients = pgTable(
  'oauth_clients',
  {
    id: text('id').primaryKey(),
    /** Null for public clients (PKCE only), which is what native apps and MCP use. */
    secretHash: text('secret_hash'),
    name: text('name').notNull(),
    redirectUris: json<string[]>('redirect_uris').notNull(),
    grantTypes: json<string[]>('grant_types').notNull(),
    scopes: json<string[]>('scopes').notNull(),
    tokenEndpointAuthMethod: text('token_endpoint_auth_method').notNull().default('none'),
    clientUri: text('client_uri'),
    logoUri: text('logo_uri'),
    /** True when created through RFC 7591 rather than by an administrator. */
    dynamicallyRegistered: boolean('dynamically_registered').notNull().default(false),
    createdAt,
  },
  (t) => [index('oauth_clients_created_idx').on(t.createdAt)],
)

export const oauthAuthCodes = pgTable(
  'oauth_auth_codes',
  {
    /** SHA-256 of the code. Codes are single-use and short-lived. */
    codeHash: text('code_hash').primaryKey(),
    clientId: text('client_id')
      .notNull()
      .references(() => oauthClients.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    redirectUri: text('redirect_uri').notNull(),
    scopes: json<string[]>('scopes').notNull(),
    codeChallenge: text('code_challenge').notNull(),
    codeChallengeMethod: text('code_challenge_method').notNull(),
    /** Ties this code to the token family it mints, so a replay can revoke exactly those. */
    familyId: uuid('family_id').notNull(),
    /** Set when redeemed, so a replayed code is detectable rather than merely expired. */
    consumedAt: timestamp('consumed_at', { withTimezone: true }),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt,
  },
  (t) => [index('oauth_auth_codes_expires_idx').on(t.expiresAt)],
)

export const oauthTokens = pgTable(
  'oauth_tokens',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tokenHash: text('token_hash').notNull(),
    kind: text('kind', { enum: ['access', 'refresh'] }).notNull(),
    clientId: text('client_id')
      .notNull()
      .references(() => oauthClients.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    scopes: json<string[]>('scopes').notNull(),
    /**
     * Rotation lineage. Presenting an already-rotated refresh token revokes the whole
     * family, which is how a stolen token stops being useful.
     */
    familyId: uuid('family_id').notNull(),
    rotatedAt: timestamp('rotated_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt,
  },
  (t) => [
    uniqueIndex('oauth_tokens_hash_key').on(t.tokenHash),
    index('oauth_tokens_family_idx').on(t.familyId),
    index('oauth_tokens_user_client_idx').on(t.userId, t.clientId),
    index('oauth_tokens_expires_idx').on(t.expiresAt),
  ],
)

/**
 * One-time tickets that let a signed-in browser hand a device the server address and a
 * grant in one gesture, rather than making somebody type a hostname on a phone.
 *
 * A ticket is not a credential: claiming one mints an ordinary authorization code bound
 * to a PKCE challenge the device generated, so possession of the ticket alone — a
 * photographed QR code, say — cannot be turned into a token.
 */
export const pairingTickets = pgTable(
  'pairing_tickets',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** SHA-256 of the code. The code itself is legible once, when the ticket is made. */
    codeHash: text('code_hash').notNull(),
    /** Set when redeemed. A ticket is single-use, and this is what enforces it. */
    claimedAt: timestamp('claimed_at', { withTimezone: true }),
    /** What the device called itself, so the browser can say which one paired. */
    deviceName: text('device_name'),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt,
  },
  (t) => [
    uniqueIndex('pairing_tickets_code_hash_key').on(t.codeHash),
    index('pairing_tickets_user_idx').on(t.userId),
    index('pairing_tickets_expires_idx').on(t.expiresAt),
  ],
)

// --- Uploads and jobs ---

export const uploadSessions = pgTable(
  'upload_sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    filename: text('filename').notNull(),
    mimeType: text('mime_type').notNull(),
    sizeBytes: bigint('size_bytes', { mode: 'number' }).notNull(),
    receivedBytes: bigint('received_bytes', { mode: 'number' }).notNull().default(0),
    tempPath: text('temp_path').notNull(),
    metadata: json<Record<string, unknown>>('metadata'),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    createdAt,
  },
  (t) => [
    index('upload_sessions_user_idx').on(t.userId),
    index('upload_sessions_expires_idx').on(t.expiresAt),
  ],
)

export const jobs = pgTable(
  'jobs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull(),
    payload: json<Record<string, unknown>>('payload').notNull(),
    status: text('status', { enum: ['queued', 'running', 'done', 'failed'] })
      .notNull()
      .default('queued'),
    attempts: integer('attempts').notNull().default(0),
    maxAttempts: integer('max_attempts').notNull().default(5),
    lastError: text('last_error'),
    runAt: timestamp('run_at', { withTimezone: true }).notNull().defaultNow(),
    startedAt: timestamp('started_at', { withTimezone: true }),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    createdAt,
  },
  // The claim query: queued work whose time has come, oldest first.
  (t) => [index('jobs_claim_idx').on(t.status, t.runAt).where(sql`${t.status} = 'queued'`)],
)

/**
 * A named (or not yet named) person: one cluster of faces the library believes belong
 * to the same human.
 */
export const people = pgTable(
  'people',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** Null until someone names them; an unnamed cluster is still browsable. */
    name: text('name'),
    /** The face shown as this person's thumbnail. */
    coverFaceId: uuid('cover_face_id'),
    /** Hidden people stay out of the people list without losing their grouping. */
    hidden: boolean('hidden').notNull().default(false),
    /**
     * Running mean of this person's face embeddings, so matching a new face is one
     * index lookup rather than a comparison against every face they appear in.
     */
    centroid: vector('centroid', { dimensions: 512 }),
    faceCount: integer('face_count').notNull().default(0),
    createdAt,
    updatedAt,
  },
  (t) => [
    index('people_owner_idx').on(t.ownerId, t.hidden),
    index('people_centroid_idx')
      .using('hnsw', t.centroid.op('vector_cosine_ops'))
      .where(sql`${t.centroid} is not null`),
  ],
)

/** One detected face in one photo. */
export const faces = pgTable(
  'faces',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    assetId: uuid('asset_id')
      .notNull()
      .references(() => assets.id, { onDelete: 'cascade' }),
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    personId: uuid('person_id').references(() => people.id, { onDelete: 'set null' }),
    /** Bounding box in the original image's pixels. */
    x: integer('x').notNull(),
    y: integer('y').notNull(),
    width: integer('width').notNull(),
    height: integer('height').notNull(),
    score: real('score').notNull(),
    embedding: vector('embedding', { dimensions: 512 }).notNull(),
    /** Set when a human confirmed or corrected the grouping, so re-clustering leaves it alone. */
    confirmed: boolean('confirmed').notNull().default(false),
    createdAt,
  },
  (t) => [
    index('faces_asset_idx').on(t.assetId),
    index('faces_person_idx').on(t.personId),
    index('faces_owner_idx').on(t.ownerId),
    index('faces_embedding_idx').using('hnsw', t.embedding.op('vector_cosine_ops')),
  ],
)

/**
 * Server settings.
 *
 * Values are always objects, never bare scalars. Bun's SQL driver serializes an object
 * bound to a jsonb parameter but binds a boolean or number natively, which Postgres
 * refuses to coerce — and pre-stringifying stores the JSON *string* "true" rather than
 * true. An envelope avoids both.
 */
export const settings = pgTable('settings', {
  key: text('key').primaryKey(),
  value: json<Record<string, unknown>>('value').notNull(),
  updatedAt,
})

export type UserRow = typeof users.$inferSelect
export type AssetRow = typeof assets.$inferSelect
export type AssetFileRow = typeof assetFiles.$inferSelect
export type AlbumRow = typeof albums.$inferSelect
export type OAuthClientRow = typeof oauthClients.$inferSelect
export type OAuthTokenRow = typeof oauthTokens.$inferSelect
export type JobRow = typeof jobs.$inferSelect
export type FaceRow = typeof faces.$inferSelect
export type PersonRow = typeof people.$inferSelect
export type UploadSessionRow = typeof uploadSessions.$inferSelect

/**
 * An invitation to open an account on a closed server.
 *
 * The alternative is opening public sign-up to add one person, which is the whole
 * reason this table exists. Only the hash of the token is kept, like every other
 * bearer token here: the link is shown to the administrator once and is not
 * recoverable from the database afterwards.
 */
export const invites = pgTable(
  'invites',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tokenHash: text('token_hash').notNull(),
    /** Optional. When set, only this address may use the link. */
    email: text('email'),
    role: text('role', { enum: ['admin', 'user'] })
      .notNull()
      .default('user'),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    acceptedAt: timestamp('accepted_at', { withTimezone: true }),
    acceptedBy: uuid('accepted_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt,
  },
  (t) => [uniqueIndex('invites_token_hash_key').on(t.tokenHash)],
)
