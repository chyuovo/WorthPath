FROM node:24-bookworm-slim AS base

RUN apt-get update \
    && apt-get install -y --no-install-recommends openssl ca-certificates \
    && rm -rf /var/lib/apt/lists/*
RUN npm install -g pnpm@11.19.0
WORKDIR /app

FROM base AS build
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
COPY apps/api/prisma apps/api/prisma
RUN pnpm install --frozen-lockfile
COPY apps ./apps
RUN pnpm db:generate && pnpm build \
    && cp -r apps/web/dist apps/api/public

FROM base AS runtime
ENV NODE_ENV=production
ENV ICON_STORAGE_DIR=/app/data/icons
RUN mkdir -p /app/data/icons && chown -R node:node /app/data
# Preserve pnpm's workspace links and Prisma CLI for explicit release migrations.
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/package.json /app/pnpm-workspace.yaml ./
COPY --from=build --chown=node:node /app/apps/api/package.json ./apps/api/package.json
COPY --from=build --chown=node:node /app/apps/api/node_modules ./apps/api/node_modules
COPY --from=build --chown=node:node /app/apps/api/dist ./apps/api/dist
COPY --from=build --chown=node:node /app/apps/api/public ./apps/api/public
COPY --from=build --chown=node:node /app/apps/api/prisma ./apps/api/prisma
COPY --from=build --chown=node:node /app/apps/api/assets ./apps/api/assets
COPY --from=build --chown=node:node /app/apps/api/scripts/database.cjs /app/apps/api/scripts/seed-icons.cjs ./apps/api/scripts/
WORKDIR /app/apps/api
USER node
EXPOSE 3100
CMD ["node", "dist/main.js"]
