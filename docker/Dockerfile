# Pinned by digest (Dependabot bumps tag and digest together).
FROM node:26.12.1-alpine@sha256:40cd011b55415bc894e45b02fdd5a5dfde056921b7d23a64c74f80497af48797 AS base

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

# Only node runs in production. Defense in depth: what stops a payload from
# installing code is the non-root user with root-owned code; npm/npx just go too.
# uid 1001 is also set up by infra/cloud-init.yml and the README's chown step.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx \
  && addgroup --system --gid 1001 nodejs \
  && adduser --system --uid 1001 --ingroup nodejs nextjs

# App code stays root-owned: the app user can read it but not rewrite it.
COPY --from=builder /app/public ./public
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/drizzle ./drizzle
COPY --from=builder --chmod=755 /app/scripts/migrate.mjs /app/scripts/start.sh ./scripts/

# Writable by the app user: Next's image cache and /data. No VOLUME: compose
# bind-mounts each data subdirectory (no orphaned anonymous volume).
RUN mkdir -p .next/cache /data && chown nextjs:nodejs .next/cache /data

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
USER nextjs
CMD ["./scripts/start.sh"]