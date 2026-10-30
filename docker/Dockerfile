FROM node:26.12.1-alpine AS base

FROM base AS builder
WORKDIR /app
COPY package.json package-lock.json ./
# Install scripts never run in the image build, so a compromised dependency
# version cannot tamper with what ships (ADR-010, option D). No runtime
# dependency needs one: better-sqlite3 ships N-API prebuilds, and esbuild /
# unrs-resolver resolve their platform binary through optional dependencies.
RUN npm ci --ignore-scripts
COPY . .
RUN npm run build

FROM base AS runner
WORKDIR /app
ENV NODE_ENV=production
RUN addgroup --system --gid 1001 nodejs
RUN adduser --system --uid 1001 nextjs
RUN apk add --no-cache su-exec

COPY --from=builder /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static

# Include Drizzle migration files
COPY --from=builder --chown=nextjs:nodejs /app/drizzle ./drizzle

# Include migration runner script
COPY --from=builder --chown=nextjs:nodejs /app/scripts/migrate.mjs ./scripts/migrate.mjs
COPY --from=builder --chown=nextjs:nodejs /app/scripts/start.sh ./scripts/start.sh
RUN chmod +x ./scripts/start.sh

# Data directory (mounted as volume) — db, tts-cache, and pdf originals
RUN mkdir -p /data/db /data/tts-cache /data/originals/images && chown -R nextjs:nodejs /data
VOLUME /data

ENV PDF_DATA_DIR=/data
# pdfjs-dist can consume 3-5× the raw PDF size when parsing. Keep the heap
# limit well below total system RAM so V8 GC does not push the process into
# OOM territory. 1 GB covers a 50 MB PDF at 5× overhead (250 MB pdfjs peak)
# plus the server baseline (~300 MB), with headroom to spare.
ENV NODE_OPTIONS="--max-old-space-size=1024"

EXPOSE 3000
ENV PORT=3000
ENV HOSTNAME="0.0.0.0"
# The one definition of "healthy": Deploy (`docker compose up --wait`) and CI's
# docker-smoke job wait on it, and `docker ps` shows it. busybox wget is far
# cheaper than starting node; probes run every 2s while starting, then every 30s.
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --start-interval=2s --retries=3 \
  CMD wget -q -T 4 -O /dev/null http://127.0.0.1:3000/api/health || exit 1
CMD ["./scripts/start.sh"]