# Contributing

Thanks for looking. imogen is small enough that a patch can land quickly.

## Getting set up

The client libraries live in a separate repository, and until they are published to npm
this one carries them as a git submodule. Clone with it:

```bash
git clone --recurse-submodules https://github.com/ergofobe/imogen-server.git
```

If you already cloned without that, `git submodule update --init` fills it in. Then:

```bash
bun install
docker compose -f docker/compose.dev.yml up -d
export DATABASE_URL='postgres://imogen:imogen@localhost:5432/imogen'
bun run db:migrate
bun run dev      # and, in another terminal, bun run dev:web
```

The `overrides` block in the root `package.json` is what points `@imogen/sdk` and
`@imogen/shared` at `imogen-sdk/`. Deleting it, and the submodule with it, is the whole of
the change once the packages are on npm.

Those two paths are spelled `file:imogen-sdk/...` with no leading `./`, which is load
bearing rather than untidy: with the `./` bun normalises the override and the SDK's own
nested `@imogen/shared` dependency to two different store keys and installs two copies of
the Zod schemas, so the server and the SDK would validate against separate instances of
the same contract. Bare, they dedupe to one.

The submodule pointer is the record of which SDK commit this repository was built and
tested against, so a change to the SDK lands here as a commit that moves it:

```bash
git -C imogen-sdk fetch origin
git -C imogen-sdk checkout <sha>    # detached HEAD: a pointer is a commit, not a branch
git add imogen-sdk && git commit -m "Move to the current SDK"
```

Two wrinkles worth knowing. bun *copies* a `file:` dependency rather than symlinking it,
so an edit in `imogen-sdk/` does not show up here until you run `bun install --force`. And
`git worktree add` does not populate submodules — a fresh worktree needs
`git submodule update --init` before anything resolves.

## Before you open a pull request

```bash
bun run verify
```

That runs lint, typecheck, and the test suite, and fails on the first
problem. Run it as one command rather than three: `bun test` does not
typecheck, so a suite that passes can still be hiding a type error.

## How this codebase is tested

Tests run against a real Postgres and a real HTTP server. That is deliberate: the
behaviour most worth protecting lives in unique indexes, transactional guards, PKCE
verification, and a generated search vector — and a mocked store would happily let all
of those be wrong.

Two habits are worth keeping:

- **Write the test first and watch it fail.** A test that passed the moment you wrote it
  has not been shown to catch anything.
- **When you fix a bug, first write the test that reproduces it.** Several bugs found
  during the initial build round-tripped cleanly through the ORM and were invisible to
  any test that did not ask the database what it had actually stored.

## Changing the API

The contract is `@imogen/shared`, which lives in
[imogen-sdk](https://github.com/ergofobe/imogen-sdk) alongside the five clients that have
to keep to it. Change the Zod schema there and the server and web app move with it; the
OpenAPI document is generated from those schemas, so it cannot drift from what the server
actually accepts.

A wire-format change needs both repositories. In imogen-sdk, update
`conformance/` and every port; here, update the server and let
`packages/server/src/api/sdk-contract.test.ts` confirm the two halves still agree. That
test is the only place they meet: the fixtures over there prove the clients agree with each
other, and nothing over there can prove the server answers them.

## Database changes

Edit `packages/server/src/db/schema.ts`, then:

```bash
bun run db:generate    # writes a migration
bun run db:migrate     # applies it
```

Commit the generated SQL.

## Notes on style

Small, focused modules. Comments explain *why* — the surprising constraint, the
alternative that was rejected — because what the code does is already on the screen.
