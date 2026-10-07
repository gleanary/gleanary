#!/bin/bash

# SessionStart hook: ensures dependencies are installed and E2E environment is ready.
# Skips steps that are already done.

# Only run in remote/web environments
if [ "$CLAUDE_CODE_REMOTE" != "true" ]; then
  exit 0
fi

PROJECT_DIR="${CLAUDE_PROJECT_DIR:-.}"

# 1. Install npm dependencies if needed
if [ -d "$PROJECT_DIR/node_modules" ] && [ -f "$PROJECT_DIR/node_modules/.package-lock.json" ]; then
  if [ "$PROJECT_DIR/package-lock.json" -ot "$PROJECT_DIR/node_modules/.package-lock.json" ]; then
    : # up to date
  else
    cd "$PROJECT_DIR" && npm install --no-audit --no-fund 2>&1
  fi
else
  cd "$PROJECT_DIR" && npm install --no-audit --no-fund 2>&1
fi

# 2. Create .env for dev/test if it doesn't exist
if [ ! -f "$PROJECT_DIR/.env" ]; then
  cat > "$PROJECT_DIR/.env" <<'ENVEOF'
DATABASE_URL=file:./data/gleanary.db
NODE_ENV=development
LOG_LEVEL=debug
PORT=3000
ENVEOF
fi

# 3. Create data directory and run migrations if DB doesn't exist
DB_PATH="$PROJECT_DIR/data/gleanary.db"
if [ ! -f "$DB_PATH" ]; then
  mkdir -p "$PROJECT_DIR/data"
  cd "$PROJECT_DIR" && npx drizzle-kit migrate 2>&1
fi

exit 0
