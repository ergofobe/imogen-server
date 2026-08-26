# syntax=docker/dockerfile:1

# The build context is the directory holding both imogen-server and imogen-sdk, not this
# repository:
#
#     docker build -f imogen-server/Dockerfile -t imogen .
#
# The client packages are resolved from a sibling checkout until they are published, and a
# build context cannot reach outside itself. Once they are on npm this reverts to an
# ordinary context of `.` and the two COPY lines below go away.

# ---- Build ----------------------------------------------------------------
FROM oven/bun:1.3-debian AS build
WORKDIR /app

# /app/../imogen-sdk is where package.json's overrides say the client packages are, so
# this is the layout the install expects rather than a convenience.
COPY imogen-sdk/typescript/packages/shared /imogen-sdk/typescript/packages/shared
COPY imogen-sdk/typescript/packages/sdk /imogen-sdk/typescript/packages/sdk

# Manifests first, so a dependency layer is only rebuilt when dependencies change.
COPY imogen-server/package.json imogen-server/bun.lock ./
COPY imogen-server/packages/server/package.json packages/server/
COPY imogen-server/packages/mcp/package.json packages/mcp/
COPY imogen-server/packages/web/package.json packages/web/
RUN bun install --frozen-lockfile

COPY imogen-server/ .
RUN bun run --filter '@imogen/web' build

# The reference viewer is copied into the web bundle during that build, so the
# devDependency it came from has done its job. Reinstalling without development
# dependencies keeps several hundred packages out of the runtime image.
RUN rm -rf node_modules && bun install --frozen-lockfile --production

# ---- Runtime --------------------------------------------------------------
FROM oven/bun:1.3-debian AS runtime
WORKDIR /app

# Neither of these is optional.
#
# sharp's prebuilt binary parses HEIF containers but cannot decode the HEVC-coded pixels
# every iPhone produces, so something else must. libheif's own decoder (heif-dec) is what
# handles HEIC: an iPhone photo is a grid of 512x512 tiles, and ffmpeg on some platforms
# returns a single tile rather than the assembled image — importing a 3000x2000 photo as
# 512x512 while reporting success.
#
# ffmpeg covers everything else: camera RAW, exotic containers, and video poster frames.
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
     ffmpeg libheif-examples libheif-plugin-libde265 ca-certificates \
  && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production \
    IMOGEN_DATA_DIR=/data \
    IMOGEN_PORT=3000

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/packages/server ./packages/server
COPY --from=build /app/packages/mcp ./packages/mcp
COPY --from=build /app/packages/web/dist ./packages/web/dist

# Photographs are the user's data; the process that serves them does not need root.
RUN mkdir -p /data && chown -R bun:bun /data /app
USER bun

EXPOSE 3000
VOLUME ["/data"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD bun --eval "const r = await fetch('http://127.0.0.1:3000/api/v1/health'); process.exit(r.ok ? 0 : 1)"

# Migrations run at start-up so an upgrade is just `docker compose pull && up -d`.
CMD ["sh", "-c", "bun packages/server/src/db/migrate.ts && bun packages/server/src/index.ts"]
