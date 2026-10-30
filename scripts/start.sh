#!/bin/sh
set -e

# Runs as the image's non-root user (USER nextjs): no chown, no privilege drop.
# migrate.mjs, pdf-storage and tts-cache create the directories they need.
echo "[start] Running database migrations..."
node scripts/migrate.mjs

echo "[start] Starting Next.js server..."
exec node server.js
