# Build context is the REPO ROOT, not ./server — the dashboard lives in client/
# and builds into server/public. Wired in docker-compose.yml as `context: .`
# plus `dockerfile: server/Dockerfile`, so every path below is repo-relative.
# See docs/adr/0004-same-origin-web-dashboard.md.

# ─── Stage 1: build the dashboard ────────────────────────────────
# A separate stage so the frontend toolchain (vite, typescript, its whole
# node_modules tree) never reaches the runtime image — only the static output.
FROM node:20 AS client

# Mirrors the repo layout, because vite.config.ts writes to `../server/public`.
WORKDIR /repo/client

COPY client/package*.json ./
RUN npm ci

COPY client/ ./
RUN npm run build

# ─── Stage 2: the server ─────────────────────────────────────────
FROM node:20

WORKDIR /app

# Copy dependency configuration files
COPY server/package*.json ./

# Install npm dependencies
RUN npm ci --verbose

# No browser is installed, deliberately. The email finder's provider lookup
# needs a real user browser to pass Cloudflare Turnstile, which no server-side
# Chromium achieves (measured — see docs/adr/0005-server-side-email-finder.md),
# so that layer runs in the Chrome extension instead. The server does the API
# and pattern+SMTP layers, neither of which needs a browser.

# Copy the rest of the application files
COPY server/ ./

# Generate Prisma Client classes
RUN npx prisma generate

# Compile TypeScript to JavaScript
RUN npm run build

# The dashboard. After `COPY server/` on purpose: a stale locally-built
# server/public sitting in the build context must not win over stage 1's output.
COPY --from=client /repo/server/public ./public

EXPOSE 3000

# Apply migrations, then start. NOT `db push`: push diffs the schema straight
# onto the database and never records anything in `_prisma_migrations`, so the
# hand-written SQL inside a migration (the `DELETE FROM "LinkedInSession"` guard,
# for one) never ran on the VM, and push refuses a destructive change without
# --accept-data-loss — the next dropped column would fail the deploy at boot.
#
# `migrate deploy` needs `_prisma_migrations` to agree with the database. A
# database previously built by `db push` has the tables but no such table, so
# `init` would try to recreate them and fail. Baseline it once, on the VM:
#   docker exec cc-server sh -c 'for m in $(ls prisma/migrations | grep -v lock); \
#     do npx prisma migrate resolve --applied "$m"; done'
# (or drop and recreate the database and let `init` build it, while it is empty).
CMD ["sh", "-c", "npx prisma migrate deploy && node dist/index.js"]
