<div align="center">
  <img src="packages/web/public/icons/icon.svg" width="72" height="72" alt="">
  <h1>imogen</h1>
  <p><strong>Your photo library, on your own server.</strong></p>
</div>

imogen is a self-hosted photo and video library for a home lab. It holds your
photographs on hardware you control, and it opens them to whatever you want to build:
a web interface, a REST API, a TypeScript SDK for a mobile app, and an MCP endpoint so
your AI assistants can search the library too.

- **Justified timeline** — photos keep the proportions they were shot in, grouped by day
- **Everything a camera produces** — HEIC, RAW, JPEG, video, Live Photos
- **Installable** — the web interface is a PWA and works offline
- **Two ways to sign in** — local accounts, or single sign-on through Authentik,
  Keycloak, Google, or anything else that speaks OIDC
- **Built to be built on** — OpenAPI, an SDK, and an OAuth 2.1 server, so a third-party
  app is a first-class citizen rather than an afterthought
- **People** — optional face grouping, running entirely on your own server
- **A vault** — photos that need a passphrase to see, hidden from everything else
- **Sharing** — publish an album or a single photograph as a link, with an optional
  password, an expiry date, and downloads on or off
- **Administration** — invite people, suspend accounts, watch the processing queue,
  disconnect apps, and see everything that is currently public
- **Agent-ready** — connect Claude or Grok to your library with a URL

---

## Running it

```bash
curl -O https://raw.githubusercontent.com/ergofobe/imogen-server/main/docker-compose.yml
docker compose up -d
```

Open <http://localhost:3000>. The first account you create becomes the administrator.

That is the whole installation. imogen needs Postgres, and the compose file brings one
up; there is no message broker, no cache, and no sidecar to run.

### Configuration

Everything is an environment variable, validated at start-up — the server refuses to
boot on a bad configuration rather than failing later under load.

| Variable | Default | What it does |
|---|---|---|
| `IMOGEN_PUBLIC_URL` | `http://localhost:3000` | The URL people reach imogen at. OAuth and share links are built from it, so it must be correct behind a reverse proxy. |
| `DATABASE_URL` | — | Postgres connection string. Required. |
| `IMOGEN_DATA_DIR` | `/data` | Where photographs live. Back this up. |
| `IMOGEN_SECRET` | generated | Signs sessions. Generated and persisted on first run if unset. |
| `IMOGEN_ALLOW_SIGNUP` | `true` | Whether anyone may create an account. The first account is always allowed. A starting value only — an administrator can change this in the app, and what they set wins. |
| `IMOGEN_TRASH_RETENTION_DAYS` | `30` | How long deleted photos are recoverable. Also a starting value that an administrator can change. |
| `IMOGEN_JOB_CONCURRENCY` | `4` | Photos processed at once. Raise it on a machine with cores to spare. |

### Administration

The first account created becomes the administrator. Its Settings page has a link
through to `/admin`, which is where accounts, invitations, the processing queue,
connected applications, storage and share links are managed.

The area is not merely closed to everyone else — it answers a plain 404, identical to
the one the server gives for a path it has never heard of, so it cannot be found by
looking for it. Anything scanning for an administration panel is told nothing.

To add somebody to a closed server, make an invitation and send them the link. The
link is shown once and stored only as a hash, so if it is lost, revoke it and make
another.

### Single sign-on

Point imogen at any OIDC provider. Set the redirect URI in your provider to
`https://photos.example.com/api/v1/auth/oidc/callback`.

```yaml
IMOGEN_OIDC_ISSUER: https://auth.example.com/application/o/imogen/
IMOGEN_OIDC_CLIENT_ID: ...
IMOGEN_OIDC_CLIENT_SECRET: ...
IMOGEN_OIDC_LABEL: Sign in with Authentik
IMOGEN_OIDC_ADMIN_VALUE: imogen-admins   # members of this group become administrators
IMOGEN_OIDC_ACCOUNT_URL: ''              # optional; guessed for Authentik and Keycloak
```

Existing local accounts are linked by verified email address, so turning on SSO does not
strand anyone.

The provider owns the name and email of the accounts it manages: imogen re-reads them at
every sign-in, shows them read-only in settings, and links out to the provider's own
account page. Set `IMOGEN_OIDC_ACCOUNT_URL` if that link needs to point somewhere other
than the guess.

Administrator status follows `IMOGEN_OIDC_ADMIN_VALUE` when you set it — including
removing it when someone leaves the group. Leave it unset and imogen never touches roles,
so an administrator promoted locally stays one.

### Behind a reverse proxy

imogen serves plain HTTP and expects to sit behind something that terminates TLS. Pass
through `X-Forwarded-For` so sessions record a sensible address, allow large request
bodies for video uploads, and set `IMOGEN_PUBLIC_URL` to the external URL.

```caddy
photos.example.com {
    reverse_proxy localhost:3000
    request_body { max_size 8GB }
}
```

---

## People

imogen can find faces and group the photos each person appears in, so you can name
someone once and then browse everything they are in. Detection and recognition run on
your server; no photograph is sent anywhere.

It is **off until you turn it on**, from the People page. Enabling it downloads about
190 MB of recognition models and scans your existing library in the background.

- Photos in your vault are never scanned, and vaulting a photo forgets the faces already
  found in it.
- Nobody is named until you name them. Unnamed groups are shown so you can name them,
  and either can be hidden.
- Grouping errs toward splitting a person across two groups rather than merging two
  people into one. Select several and tell it they are the same person.

**A note on the models.** imogen uses InsightFace's SCRFD and ArcFace, which are licensed
for non-commercial research use. imogen ships no models: your server downloads them when
you enable the feature, so the licence decision stays with you. If that does not suit
your situation, leave the feature off.

---

## The vault

Some photographs should not be one careless scroll away. Move them to the vault and they
leave the library completely: not the timeline, not search, not your albums, not a shared
link, and not anything an AI assistant can see.

Opening it needs a passphrase, entered again even though you are already signed in.

A few decisions worth knowing about:

- **The passphrase is not your account password.** Single sign-on accounts have no local
  password, and more to the point, a session that is already signed in should not be
  enough — finding your laptop open should not open this too.
- **Only a browser session can open it.** An API token or an MCP connector can hold
  perfectly valid credentials and still have no way in. That is by construction, not by
  omission.
- **It closes itself** after fifteen minutes, or immediately when you ask it to.
- **Nobody can reset it for you.** There is no recovery path, which is the point.

Moving a photo into the vault also removes it from every album, since an album is
something you can share.

---

## Connecting an AI assistant

imogen speaks MCP, so an assistant can search your library, look at a photo, and manage
albums — with your permission and nothing else.

**Claude.ai or Grok:** add a connector pointing at `https://photos.example.com/mcp`.
Nothing is pasted by hand: the client discovers imogen, registers itself, and sends you
to a consent screen that names exactly what it is asking for. Revoke it any time from
settings.

**A local agent** (Claude Code, or anything that speaks MCP over stdio):

```bash
bun add -g @imogen/mcp
imogen-mcp login --server https://photos.example.com
```

```json
{ "mcpServers": { "imogen": { "command": "imogen-mcp" } } }
```

### What an assistant can do

| Tool | Permission |
|---|---|
| `search_photos` · `get_photo` · `get_photo_image` · `get_library_stats` | `library:read` |
| `list_albums` · `get_album` | `albums:read` |
| `create_album` · `add_to_album` | `albums:write` |
| `search_by_person` · `list_people` | `library:read` |

Every tool is scoped to the connected account. There is no tool that deletes anything, and
nothing in the vault is visible to any of them. Only people you have named are findable —
unnamed groupings and hidden people are not.

---

## Building on it

The API is documented at `/api/v1/docs`, with the OpenAPI 3.1 description at
`/api/v1/openapi.json`.

There are clients for five languages in
[imogen-sdk](https://github.com/ergofobe/imogen-sdk) — TypeScript, Rust, Python, Swift and
Kotlin. In TypeScript:

```bash
bun add @imogen/sdk
```

```ts
import { ImogenClient } from '@imogen/sdk'

const imogen = new ImogenClient({ baseUrl: 'https://photos.example.com', token })

const page = await imogen.assets.list({ q: 'harbour', limit: 50 })
for await (const asset of imogen.assets.iterate()) console.log(asset.originalFilename)

// Picks its protocol by size: one request for photos, a resumable session for video.
await imogen.assets.uploadMany(files, {
  onFileComplete: (outcome, done, total) => console.log(`${done}/${total}`),
})
```

### Writing a mobile app

Every SDK ships the OAuth client a native app needs — the Swift and Kotlin ones are there
for exactly this. Nothing is hard-coded: the app registers itself, so it works against any
imogen server its user points it at.

```ts
import { OAuthClient } from '@imogen/sdk'

const oauth = new OAuthClient('https://photos.example.com')
const client = await oauth.register('My Photo App', ['myapp://oauth'])
const pending = await oauth.beginAuthorization(client.client_id, 'myapp://oauth')

// Open pending.authorizationUrl in the system browser, then on the callback:
const tokens = await oauth.completeAuthorization(pending, callbackUrl)
```

Uploads are idempotent by content: re-sending a photo the server already has returns
the existing asset instead of storing a second copy, so a sync loop can be simple and
still be correct. Pass `deviceAssetId` and a client knows what it has already sent
without keeping its own ledger.

---

## Developing

```bash
git clone https://github.com/ergofobe/imogen-server
cd imogen-server
bun install

docker compose -f docker/compose.dev.yml up -d     # Postgres
export DATABASE_URL='postgres://imogen:imogen@localhost:5432/imogen'
bun run db:migrate

bun run dev        # API on :3000
bun run dev:web    # web on :5173, proxying to the API
```

```bash
bun test          # needs the dev Postgres running
bun run typecheck
bun run lint
```

Tests run against a real Postgres and a real HTTP server rather than mocks. The parts
worth getting right — the OAuth flows, cursor pagination, the media pipeline — are
exactly the parts a mock would let you get wrong.

### Layout

| Package | What it is |
|---|---|
| `packages/server` | Hono app: routes, auth, media pipeline, job workers. |
| `packages/web` | The React PWA. It consumes `@imogen/sdk` like any third-party client, which keeps the SDK honest. |
| `packages/mcp` | The stdio bridge for local agents. |

The client libraries live in their own repository,
[imogen-sdk](https://github.com/ergofobe/imogen-sdk) — TypeScript, Rust, Python, Swift and
Kotlin, checked against one shared set of contract fixtures. `@imogen/shared`, the Zod
schemas this server validates against and generates its OpenAPI document from, lives there
too: it is the API contract, and the contract belongs with the clients that have to keep to
it.

`packages/server/src/api/sdk-contract.test.ts` is this side of that arrangement. It stands
up a real app and drives it through the published TypeScript client, which is the only
place the two halves can be shown to agree.

The design document is in [`docs/superpowers/specs`](docs/superpowers/specs/).

---

## Not there yet

Semantic search — finding a photo by describing it — is not implemented. The schema
reserves a vector column on assets and the search index is in place, so it can arrive
without a migration, but today search covers filenames, descriptions, places, camera
metadata, and the people you have named.

Also absent: reverse geocoding (coordinates are shown as coordinates), video
transcoding, and S3 storage. The storage driver is an interface, so S3 is a contained
change when someone wants it.

Face grouping works but has rough edges worth knowing about. It reads frontal, reasonably
lit faces well; profiles, sunglasses, motion blur, and young children — whose faces change
faster than a stored average can follow — are where it will disappoint you. It errs toward
splitting one person across two groups rather than merging two people, on the grounds that
the first is a click to fix and the second files somebody's photographs under another
person's name.

## Licence

AGPL-3.0-or-later. If you run a modified imogen as a service, share the modifications.
