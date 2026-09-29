# syntax=docker/dockerfile:1

# Two images from one file, selected with `--target`:
#
#   docker build -t pebble-api .                          # the service (default)
#   docker build -t pebble-migrate --target migrate .     # the migration step
#
# Two rather than one because `docs/migrations.md` makes migrations a separate
# deploy step that never runs at boot, and because running them needs
# `drizzle-kit` — a devDependency the service image deliberately does not carry.
# The deploy order is: run `pebble-migrate` once to completion, then roll out
# `pebble-api`.

# Matches the Node the project is developed and tested on. Alpine because
# nothing here compiles native code — `pg` is pure JavaScript unless `pg-native`
# is installed, and it is not.
ARG NODE_VERSION=24

# ---------------------------------------------------------------------------
# Full dependency tree — what building and migrating both need.
# ---------------------------------------------------------------------------
FROM node:${NODE_VERSION}-alpine AS deps
WORKDIR /app

# The manifests alone first, so this layer is reused by every build that does
# not change a dependency — which is most of them.
COPY package.json package-lock.json ./
RUN npm ci

# ---------------------------------------------------------------------------
# Compile to `dist/`.
# ---------------------------------------------------------------------------
FROM deps AS build
COPY . .
RUN npm run build

# ---------------------------------------------------------------------------
# Production dependencies only — what the running service needs.
# ---------------------------------------------------------------------------
FROM node:${NODE_VERSION}-alpine AS prod-deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# ---------------------------------------------------------------------------
# The migration step. Run it once per deploy, before the new service starts,
# and never two at a time — nothing in `drizzle-kit` takes a lock.
#
# Takes `DATABASE_URL` from the environment, exactly as the service does.
# ---------------------------------------------------------------------------
FROM deps AS migrate

# All three are read at apply time, relative to the working directory:
# `drizzle-kit` resolves the config, then the schema path it names (and exits
# if that file is missing, even though `migrate` never reads it), then the SQL
# in `drizzle/`. Leaving out `drizzle/` is the dangerous omission — the run
# still reports success, against a database it never touched.
COPY drizzle.config.ts ./
COPY src/core/database/schema.ts ./src/core/database/schema.ts
COPY drizzle ./drizzle

USER node

# The binary directly rather than through `npm run`, so the exit code a
# pipeline waits on is `drizzle-kit`'s own and nothing sits between it and a
# SIGTERM.
CMD ["node_modules/.bin/drizzle-kit", "migrate"]

# ---------------------------------------------------------------------------
# The service. Last, so a plain `docker build` produces it.
# ---------------------------------------------------------------------------
FROM node:${NODE_VERSION}-alpine AS runtime

# Also selects JSON logs (see `pino-options.ts`) and switches on the boot-time
# checks in `env.schema.ts` that refuse a production start without a real
# mailer and the Google sign-in settings.
ENV NODE_ENV=production

WORKDIR /app

# Owned by root and only readable by the process: the service writes nothing to
# its own directory, so there is no reason to let it.
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
# The legal pages, read from disk at boot; `nest build` does not copy non-TS
# files into `dist/`.
COPY public ./public
COPY package.json ./

# The unprivileged user the official image ships with.
USER node

# Documentation only — the port actually listened on is `PORT`, which defaults
# to this.
EXPOSE 3000

# Liveness, not readiness: the container is healthy when the process answers,
# regardless of the database. See `health.controller.ts` for why a dependency
# outage must not get containers restarted. `fetch` is built into Node, so this
# needs no curl or wget in the image.
HEALTHCHECK --interval=10s --timeout=3s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 3000) + '/health/live').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"

# `node` as PID 1 rather than `npm start`. npm does not forward SIGTERM to its
# child, so under it the shutdown hooks in `main.ts` — close the server, drain
# the pool — would never run, and every deploy would cut requests off mid-flight.
CMD ["node", "dist/main.js"]
