#!/bin/sh
set -e

# Ensure data directories exist and are writable by nextjs user
mkdir -p /data/db /data/originals/images
chown -R nextjs:nodejs /data/db /data/originals

echo "[start] Running database migrations..."
su-exec nextjs node scripts/migrate.mjs

echo "[start] Starting Next.js server..."
exec su-exec nextjs node server.js
