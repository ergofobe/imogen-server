# syntax=docker/dockerfile:1

# The web bundle is an input. Put the already-built files in web-dist/ (index.html
# at the top), then the image:
#
#     docker build -t imogen .
#
# This image does not compile a UI. It copies web-dist to packages/web/dist, which is
# where the server reads the bundle. web-dist is not the app source. The client
# packages are a submodule at ./imogen-sdk, so they
# are inside the context;
# build from a clone made with --recurse-submodules or the two COPY lines below fail the
# build outright. Once the packages are on npm those lines go away with the overrides
# block.

# ---- Build ----------------------------------------------------------------
FROM oven/bun:1.3-debian AS build
WORKDIR /app

# package.json's overrides resolve the client packages at ./imogen-sdk, so they have to
# be in place for the install rather than arriving later with the rest of the source.
COPY imogen-sdk/typescript/packages/shared imogen-sdk/typescript/packages/shared
COPY imogen-sdk/typescript/packages/sdk imogen-sdk/typescript/packages/sdk

# Manifests first, so a dependency layer is only rebuilt when dependencies change.
COPY package.json bun.lock ./
COPY packages/server/package.json packages/server/
COPY packages/mcp/package.json packages/mcp/
RUN bun install --frozen-lockfile --production

COPY . .
# Fail here, before the runtime stage, when the context has no bundle.
# web-dist is the supplied bundle. The server still reads packages/web/dist.
RUN test -s web-dist/index.html \
 && mkdir -p packages/web/dist \
 && cp -a web-dist/. packages/web/dist/

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
