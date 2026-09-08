# imogen — Design Document

**Date:** 2026-08-26
**Repo:** `ergofobe/imogen-photos`
**Status:** Approved for implementation

## 1. Purpose

imogen is a self-hosted photo and video library — an open-source alternative to Google
Photos for a home lab. It runs as a Docker container, owns its own storage, and exposes
four surfaces over one data model:

1. A responsive web UI, installable as a PWA.
2. A versioned REST API with an OpenAPI description.
3. A TypeScript SDK generated against that API, for building native mobile clients.
4. An MCP server so a user's AI agents can search and read the library.

Success means: a user drops a folder of iPhone photos on the web UI, sees them appear in
a fast, attractive timeline within seconds, can find them again by date, place, or text,
and can point Claude at the same library with a connector URL.

## 2. Scope

**In scope for v1:** ingest (single and bulk), HEIC/RAW/video handling, EXIF extraction,
thumbnails, timeline browsing, albums, favourites, trash, sharing links, native auth,
OIDC SSO, an OAuth 2.1 authorization server, the REST API, the SDK, the MCP toolkit,
PWA packaging, and a Docker deployment.

**Explicitly deferred:** face recognition and CLIP semantic search (the schema reserves
room for both — see §6.6), multi-node scaling, S3 storage, and video transcoding beyond
thumbnail extraction.

## 3. Architecture

A single Bun process serves everything; Postgres holds metadata; the filesystem holds
pixels. Nothing else is required to run imogen.

```
                    ┌───────────────────────────────────────┐
  Browser (PWA) ──► │  Bun + Hono                           │
  Mobile app ─────► │                                       │
  (via SDK)         │   /            static web bundle      │
                    │   /api/v1      REST + OpenAPI         │
  Claude / Grok ──► │   /mcp         MCP Streamable HTTP    │ ──► Postgres 17
  (MCP connector)   │   /oauth/*     OAuth 2.1 AS           │      + pgvector
                    │   /.well-known auth metadata          │
                    │                                       │ ──► /data
                    │   worker pool  ingest jobs            │      library/
                    └───────────────────────────────────────┘      thumbs/
```

The process is a monolith on purpose. A home lab server should not need a message broker,
a cache, and three containers to show someone their holiday photos. The seams that would
let it split later — the storage driver, the job queue, the media pipeline — are
interfaces, not distributed systems.

### 3.1 Repository layout

A Bun workspace monorepo:

| Package | Responsibility |
|---|---|
| `packages/shared` | Zod schemas and types shared by every other package. The single source of truth for the API contract. |
| `packages/server` | Hono app: routes, auth, media pipeline, job workers, database access. |
| `packages/web` | React PWA. Consumes `@imogen/sdk` like any third-party client would. |
| `packages/sdk` | `@imogen/sdk` — typed HTTP client for browser, Node, Bun, and React Native. |
| `packages/mcp` | MCP tool definitions, plus a stdio bridge binary for local agent use. |

`web` depending on `sdk` is deliberate: it keeps the SDK honest. If the SDK cannot express
something the web UI needs, the SDK is wrong.

## 4. Data model

Ten tables. The interesting ones:

**`assets`** — one row per photo or video. Holds `checksum` (SHA-256 of the original),
`ownerId`, `type`, `originalPath`, capture timestamp, dimensions, duration, GPS
coordinates, camera make/model, and a `livePhotoVideoId` self-reference for iPhone
motion photos. `(ownerId, checksum)` is unique: re-uploading the same file is a no-op that
returns the existing asset. `(ownerId, deviceAssetId)` is unique where present, which is
how a mobile app knows what it has already synced.

**`assetFiles`** — derivatives. One row per (asset, variant): `thumbnail`, `preview`,
`original`. Keeping these out of `assets` means a re-encode does not rewrite the asset row,
and a future storage migration touches one table.

**`albums`, `albumAssets`** — ordered membership, with a cover asset.

**`users`, `sessions`** — native identity. `sessions` stores a hash of the token, never the
token.

**`oauthClients`, `oauthAuthCodes`, `oauthTokens`** — the authorization server's state.
Clients may be dynamically registered (§5.3).

**`jobs`** — the queue (§6.5).

Trash is a `deletedAt` timestamp on `assets`, swept by a job after a retention window.
Nothing is destroyed on a user's first click.

## 5. Authentication

Three distinct problems, deliberately not conflated:

### 5.1 Native accounts

Email and password. Argon2id via `Bun.password`. On success the server issues an opaque
128-bit session token, stores its SHA-256 hash, and sets an `HttpOnly; Secure; SameSite=Lax`
cookie. The first account created becomes the administrator; subsequent signups obey an
admin-controlled toggle.

### 5.2 OIDC single sign-on

Generic OIDC via discovery, so Authentik, Keycloak, Auth0, and Google all work through one
code path. An admin supplies issuer URL, client ID, and secret. Users are auto-provisioned
on first login and matched to existing accounts by verified email. An optional claim-to-role
mapping grants admin rights from a group membership.

### 5.3 imogen as an OAuth 2.1 authorization server

This is what mobile apps and AI connectors authenticate against, and it is the part most
easily got wrong. imogen implements:

- **RFC 8414** — authorization server metadata at `/.well-known/oauth-authorization-server`
- **RFC 9728** — protected resource metadata at `/.well-known/oauth-protected-resource`
- **RFC 7591** — dynamic client registration at `/oauth/register`
- **Authorization Code with PKCE** (S256 required; the implicit grant is not implemented)
- **Refresh token rotation**, with reuse detection that revokes the token family

Scopes are coarse and legible on a consent screen: `library:read`, `library:write`,
`albums:read`, `albums:write`, `profile`.

Claude.ai and Grok connectors need exactly this combination — discovery, dynamic
registration, and PKCE — which is why the MCP endpoint gets a real authorization server
rather than an API key.

## 6. Media pipeline

### 6.1 Upload

`POST /api/v1/assets` takes multipart form data: the file, plus optional client metadata
(`deviceAssetId`, `capturedAt`, `favorite`). The server streams the body to a temporary
file while hashing it, then checks `(ownerId, checksum)`. A hit returns `200` with the
existing asset and the pixels are discarded; a miss moves the file into the library and
returns `201`.

Large videos use a chunked protocol — `POST /api/v1/uploads` to open a session, `PATCH` to
append at an offset, `POST .../complete` to finalize — so a phone on a flaky connection
resumes instead of restarting. The SDK picks the protocol by file size; callers do not
have to think about it.

Bulk upload is client-side concurrency over the single-asset endpoint, not a separate
server API. Six parallel requests saturate a home lab's disk, and every upload stays
independently retryable.

### 6.2 Decode

sharp handles JPEG, PNG, WebP, AVIF, GIF, TIFF, and — as verified on the target
toolchain — HEIC. Formats it rejects (camera RAW, exotic containers) fall back to ffmpeg
decoding to a PNG pipe, which sharp then consumes. Video thumbnails come from ffmpeg
seeking to the first non-black frame.

The fallback is what makes the pipeline safe: a format nobody anticipated degrades to a
slower path rather than a failed import.

### 6.3 Derivatives

Two, both WebP: a 320px `thumbnail` for grid cells and a 1440px `preview` for the viewer.
Originals are never modified. EXIF orientation is baked into derivatives so the client
never rotates.

### 6.4 Metadata

`exifr` extracts capture time, GPS, camera make and model, lens, and orientation. Capture
time resolution order: EXIF `DateTimeOriginal` **with its `OffsetTimeOriginal`**, then
client-supplied `capturedAt`, then an EXIF wall clock with no offset read as UTC, then file
mtime, then upload time. An EXIF time only outranks the client when the file says which
zone it was written in; without that it is a wall clock, and the client already resolved
the instant. Getting this order right is what makes the timeline correct for scanned
photos and screenshots alike.

### 6.5 Jobs

A `jobs` table polled by an in-process worker pool using `SELECT ... FOR UPDATE SKIP LOCKED`.
Handlers are registered by name; failures retry with exponential backoff and land in a dead
letter state after a configurable number of attempts.

Postgres is already a dependency and a home lab does not need Redis to resize a thumbnail.
The queue interface is narrow enough that swapping the backend later is a contained change.

### 6.6 Reserved for search

`assets` carries a nullable `vector(512)` column and a generated `tsvector` over filename,
description, and location. Full-text search ships in v1; the embedding column stays null
until an optional ML sidecar exists. The schema does not need to change when it does.

## 7. Web UI

React 19, Vite, Tailwind, TanStack Query, React Router. The design target is "attractive"
in the specific sense of getting out of the way: a justified, virtualized grid that keeps
its scroll position, a date scrubber, and a viewer that opens instantly because the preview
is already cached.

Responsiveness is structural, not a breakpoint afterthought — the same components take a
bottom tab bar under 768px and a sidebar above it. `vite-plugin-pwa` provides the offline
shell, an app manifest, and a Web Share Target so photos can be shared to imogen from an
Android share sheet.

## 8. MCP toolkit

A Streamable HTTP endpoint at `/mcp`, authorized by the OAuth server in §5.3, exposing:

| Tool | Purpose |
|---|---|
| `search_photos` | Query by text, date range, place, album, or favourite status |
| `get_photo` | Full metadata for one asset |
| `get_photo_image` | The image itself, as an MCP image content block |
| `list_albums` / `get_album` | Album browsing |
| `create_album` / `add_to_album` | Album mutation (requires `albums:write`) |
| `get_library_stats` | Counts, date range, storage used |

Every tool is scoped to the authenticated user. Read tools require `library:read`; there is
no ambient access and no tool that deletes anything.

`packages/mcp` also builds a stdio bridge, so a local agent can talk to the same toolkit
over a pipe using an OAuth token, without exposing the server to the network.

## 9. Deployment

A multi-stage Dockerfile: Bun builds the web bundle and server, then a slim runtime layer
carries ffmpeg and the built output. `docker-compose.yml` brings up imogen plus
`pgvector/pgvector:pg17`, with `/data` and the database on named volumes.

Configuration is environment variables, validated by Zod at boot. The process refuses to
start on an invalid configuration rather than failing later under load. A published
`IMOGEN_SECRET` default does not exist — the server generates one on first run and persists
it, or fails if it cannot.

## 10. Testing

`bun test` throughout. Unit tests for the media pipeline, the OAuth flows, and the job
queue run against fixtures and a disposable Postgres. Route tests exercise the Hono app
through real HTTP against an in-memory server. The OAuth server gets adversarial tests —
PKCE downgrade, code replay, refresh reuse, scope escalation — because that is the surface
where a mistake is a security bug rather than a defect.

## 11. Build order

Each phase ends with something that runs.

1. **Foundation** — workspace, shared schemas, database schema, migrations, config, health check.
2. **Auth** — native accounts, sessions, OIDC, OAuth 2.1 server.
3. **Media** — storage driver, decode pipeline, job queue, upload and asset endpoints.
4. **API** — albums, search, sharing, OpenAPI document.
5. **SDK** — typed client, published from the OpenAPI contract.
6. **Web** — PWA shell, timeline, viewer, upload, albums.
7. **MCP** — HTTP endpoint, tools, stdio bridge.
8. **Ship** — Dockerfile, compose, CI, documentation.
