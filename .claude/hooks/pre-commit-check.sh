#!/bin/bash

# Pre-commit hook for Claude Code: blocks git commit if any check fails.
# Runs automatically via PreToolUse hook on Bash commands containing "git commit".
#
# Enforces:
#   1. npm run lint       — code style and formatting
#   2. npm run typecheck  — TypeScript strict mode
#   3. npm run test       — unit and integration tests
#   4. CHANGELOG.md       — must be in staged changes

INPUT=$(cat)
COMMAND=$(echo "$INPUT" | jq -r '.tool_input.command')

# Only intercept git commit commands
if ! echo "$COMMAND" | grep -qE '^\s*git\s+commit\b'; then
  exit 0
fi

CWD=$(echo "$INPUT" | jq -r '.cwd')

# 1. Lint
if ! npm run lint --prefix "$CWD" > /dev/null 2>&1; then
  echo "Blocked: 'npm run lint' failed. Fix lint errors before committing." >&2
  exit 2
fi

# 2. Typecheck
if ! npm run typecheck --prefix "$CWD" > /dev/null 2>&1; then
  echo "Blocked: 'npm run typecheck' failed. Fix type errors before committing." >&2
  exit 2
fi

# 3. Tests
if ! npm run test --prefix "$CWD" > /dev/null 2>&1; then
  echo "Blocked: 'npm run test' failed. Fix failing tests before committing." >&2
  exit 2
fi

# 4. CHANGELOG.md must be staged (skip for docs-only or hook-only commits)
STAGED=$(git -C "$CWD" diff --cached --name-only 2>/dev/null)
# Only enforce if there are staged src/ or __tests__/ changes (i.e., code changes)
if echo "$STAGED" | grep -qE '^(src/|__tests__/)'; then
  if ! echo "$STAGED" | grep -q '^CHANGELOG.md$'; then
    echo "Blocked: CHANGELOG.md not staged. Add a changelog entry for code changes." >&2
    exit 2
  fi
fi

exit 0
