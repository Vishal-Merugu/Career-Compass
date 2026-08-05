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

# Run migrations/pushes and start the server
CMD ["sh", "-c", "npx prisma db push && node dist/index.js"]
