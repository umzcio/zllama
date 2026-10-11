# Build context: the repo root (one level above app/), not app/ itself.
#   docker build -f app/Dockerfile .
# app/docker-compose.yml and .github/workflows do this already.
FROM node:20-alpine AS base

FROM base AS deps
WORKDIR /app
COPY app/package.json app/package-lock.json* ./
COPY app/scripts/ ./scripts/
COPY app/prisma/ ./prisma/
RUN npm ci

FROM base AS builder
WORKDIR /app
RUN apk add --no-cache openssl
COPY --from=deps /app/node_modules ./node_modules
COPY app/ ./
# Optional sub-path for reverse-proxy deployments (e.g. /zllama).
# Must be set at build time — Next.js bakes basePath into the bundle.
ARG NEXT_PUBLIC_BASE_PATH=""
ENV NEXT_PUBLIC_BASE_PATH=${NEXT_PUBLIC_BASE_PATH}
RUN npx prisma generate
RUN npm run build

FROM base AS runner
WORKDIR /app
ENV NODE_ENV=production
RUN apk add --no-cache openssl
RUN addgroup --system --gid 1001 nodejs
RUN adduser --system --uid 1001 nextjs
# SQLite data dir; owned by the app user so a fresh named volume mounted here
# inherits writable ownership (Docker seeds an empty volume from the image path).
RUN mkdir -p /data && chown nextjs:nodejs /data
COPY --from=builder /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
COPY --from=builder /app/prisma ./prisma
COPY --from=builder /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=builder /app/node_modules/@prisma ./node_modules/@prisma
COPY --from=builder /app/node_modules/@swc ./node_modules/@swc
COPY --from=builder /app/node_modules/prisma ./node_modules/prisma
# The build context is the repo root so agent/ (a sibling of app/) can ship
# in the image: /api/agent/install and /api/agent/package serve it, and a
# target host downloads it from there. Read-only, root-owned.
COPY agent/ ./agent/
COPY app/docker-entrypoint.sh ./
RUN chmod +x docker-entrypoint.sh
USER nextjs
EXPOSE 3000
ENV PORT=3000
ENV HOSTNAME="0.0.0.0"
ENTRYPOINT ["./docker-entrypoint.sh"]
CMD ["node", "server.js"]
