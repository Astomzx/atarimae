# Atarimae — single image serving both the API and the web interface.
#
# One process, one container, one PostgreSQL. A small office should be able to
# run this without operating a reverse proxy, a static host and a worker
# separately.

# ---------------------------------------------------------------------------
# Build
# ---------------------------------------------------------------------------
FROM node:24-bookworm-slim AS build

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH

# The --prod reinstall below replaces node_modules, and pnpm asks before
# removing a directory it did not create. There is no terminal in a build, so
# it aborts with ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY instead — which is
# what the very first build of this image did.
ENV CI=true

RUN corepack enable

WORKDIR /app

# Manifests first, so a dependency-only change is the sole cause of a cache
# miss on the install layer.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY apps/server/package.json ./apps/server/
COPY apps/web/package.json ./apps/web/
COPY packages/api-schema/package.json ./packages/api-schema/
COPY packages/secret-store/package.json ./packages/secret-store/
COPY packages/backup/package.json ./packages/backup/
COPY e2e/package.json ./e2e/

RUN pnpm install --frozen-lockfile

COPY . .

# Order matters: the server and the web client both consume the workspace
# packages' generated .d.ts files.
RUN pnpm --filter @atarimae/secret-store build \
 && pnpm --filter @atarimae/api-schema build \
 && pnpm --filter @atarimae/backup build \
 && pnpm --filter @atarimae/server build \
 && pnpm --filter @atarimae/web build

# Reinstall without dev dependencies for the runtime image.
RUN pnpm install --frozen-lockfile --prod

# ---------------------------------------------------------------------------
# Runtime
# ---------------------------------------------------------------------------
FROM node:24-bookworm-slim AS runtime

ENV NODE_ENV=production
# Without this the process is unreachable from outside the container.
ENV HOST=0.0.0.0
ENV PORT=3000
ENV WEB_DIST_PATH=/app/apps/web/dist

WORKDIR /app

# PostgreSQL's own client tools, for `pnpm backup` and `pnpm restore`.
#
# Version 18 specifically, from PGDG rather than Debian: bookworm ships 15, and
# pg_dump refuses to dump a server newer than itself. That refusal is the good
# outcome — the bad one is having no pg_dump in the image at all, which is what
# this line exists to prevent, because a backup command that cannot run is
# discovered at the moment somebody needs a backup.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl \
 && install -d /usr/share/postgresql-common/pgdg \
 && curl -fsSL https://www.postgresql.org/media/keys/ACCC4CF8.asc \
      -o /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc \
 && echo "deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc] https://apt.postgresql.org/pub/repos/apt bookworm-pgdg main" \
      > /etc/apt/sources.list.d/pgdg.list \
 && apt-get update \
 && apt-get install -y --no-install-recommends postgresql-client-18 \
 && apt-get purge -y --auto-remove curl \
 && rm -rf /var/lib/apt/lists/*

# Never run as root.
RUN groupadd --system --gid 1001 atarimae \
 && useradd --system --uid 1001 --gid atarimae atarimae

COPY --from=build --chown=atarimae:atarimae /app/node_modules ./node_modules
COPY --from=build --chown=atarimae:atarimae /app/apps/server/node_modules ./apps/server/node_modules
COPY --from=build --chown=atarimae:atarimae /app/apps/server/dist ./apps/server/dist
COPY --from=build --chown=atarimae:atarimae /app/apps/server/package.json ./apps/server/
COPY --from=build --chown=atarimae:atarimae /app/apps/web/dist ./apps/web/dist
COPY --from=build --chown=atarimae:atarimae /app/packages ./packages
COPY --from=build --chown=atarimae:atarimae /app/migrations ./migrations
COPY --from=build --chown=atarimae:atarimae /app/scripts ./scripts
COPY --from=build --chown=atarimae:atarimae /app/package.json ./

USER atarimae

EXPOSE 3000

# The application's own readiness check, which includes the database.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/v1/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# Node handles SIGTERM itself; the server closes in-flight requests on it, so
# a deploy cannot abort a publish transaction midway.
CMD ["node", "apps/server/dist/server.js"]
