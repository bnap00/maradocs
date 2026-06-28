# syntax=docker/dockerfile:1

# ---- Build stage -----------------------------------------------------------
FROM node:22-alpine AS build
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable && corepack prepare pnpm@10.33.0 --activate
# Toolchain for compiling better-sqlite3's native addon on musl.
RUN apk add --no-cache python3 make g++

WORKDIR /repo
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json .npmrc tsconfig.base.json ./
COPY packages/shared/package.json ./packages/shared/
COPY packages/cli/package.json ./packages/cli/
COPY packages/skill/package.json ./packages/skill/
COPY apps/server/package.json ./apps/server/
COPY apps/dashboard/package.json ./apps/dashboard/
RUN pnpm install --frozen-lockfile

COPY . .
# Build order: shared -> dashboard (SPA) -> server (+ CLI for image users).
RUN pnpm --filter @maradocs/shared build \
  && pnpm --filter @maradocs/dashboard build \
  && pnpm --filter @maradocs/server build \
  && pnpm --filter ./packages/cli build
# Bundle the built dashboard into the server's static dir so one container
# serves both the API and the dashboard at /dashboard.
RUN mkdir -p apps/server/public/dashboard \
  && cp -r apps/dashboard/dist/* apps/server/public/dashboard/

# ---- Runtime stage ---------------------------------------------------------
FROM node:22-alpine AS runtime
ENV NODE_ENV=production
ENV PORT=8787
ENV DATA_DIR=/data
WORKDIR /app

# Copy the full built workspace (native better-sqlite3 binary included).
COPY --from=build --chown=node:node /repo /app

# Provide the `maradocs` CLI inside the image for convenience.
RUN ln -sf /app/packages/cli/dist/index.js /usr/local/bin/maradocs \
  && chmod +x /app/packages/cli/dist/index.js \
  && rm -rf /app/.git /app/.github /app/.superpowers /app/.fallow /app/docs /app/scripts \
    /app/apps/dashboard/src /app/apps/dashboard/public /app/apps/dashboard/node_modules/.tmp \
    /app/apps/server/src /app/apps/server/test /app/packages/*/src /app/packages/*/scripts \
  && mkdir -p /data \
  && chown -R node:node /data /app

USER node

VOLUME ["/data"]
EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "apps/server/dist/index.js"]
