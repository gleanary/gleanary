#!/usr/bin/env bash
#
# secret-scanner.sh — Claude Code PreToolUse hook
#
# Blocks tool calls that would read, write, or exfiltrate secrets.
# Survives --dangerously-skip-permissions (hooks always run).
#
# Install:
#   sudo install -m 0755 -o root -g wheel \
#     secret-scanner.sh /usr/local/share/claude-org/secret-scanner.sh
#
# Wired up in managed-settings.json under hooks.PreToolUse.
#
# Hook protocol (Claude Code 2.x):
#   stdin  = JSON { tool_name, tool_input, ... }
#   exit 0 = allow
#   exit 2 = block (stderr is fed back to Claude as feedback)
#   other  = non-blocking warning to user

set -euo pipefail

# ---- 0. Read the JSON payload from Claude --------------------------------

INPUT="$(cat)"
TOOL_NAME="$(jq -r '.tool_name // empty' <<<"$INPUT")"
TOOL_INPUT="$(jq -c '.tool_input // {}'   <<<"$INPUT")"

# Helper: block with a message Claude will see
block() {
  echo "BLOCKED by secret-scanner: $*" >&2
  exit 2
}

# Helper: log allowed calls for audit (stdout goes to user transcript)
audit() {
  logger -t claude-code-hook "ALLOW $TOOL_NAME: $*" 2>/dev/null || true
}

# ---- 1. Canonical sensitive-path patterns --------------------------------
#
# These are checked against any path-like field in tool_input. Defense in
# depth with the managed deny-list — the deny-list catches Read/Edit/Write,
# this catches Bash invocations like `cat ~/.ssh/id_ed25519` that bypass
# Read filters.

SENSITIVE_PATH_REGEX='(^|/)(\.ssh|\.aws|\.kube|\.gnupg|\.config/gcloud|\.config/op|\.netrc|\.docker/config\.json|\.npmrc|\.pypirc|\.git-credentials|\.claude\.json)(/|$)'
SENSITIVE_FILE_REGEX='(^|/)(\.env(\..+)?|.*\.pem|.*\.key|.*\.p12|.*\.pfx|.*\.keystore|.*wallet\.json|.*\.mnemonic|id_(rsa|ed25519|ecdsa|dsa)(\.pub)?|.*credentials.*\.json)$'

path_is_sensitive() {
  local p="$1"
  [[ -z "$p" ]] && return 1
  # normalize ~ and resolve relative
  p="${p/#\~/$HOME}"
  [[ "$p" =~ $SENSITIVE_PATH_REGEX ]] && return 0
  [[ "$p" =~ $SENSITIVE_FILE_REGEX ]] && return 0
  return 1
}

# ---- 2. Per-tool checks --------------------------------------------------

case "$TOOL_NAME" in

  Read|Edit|Write|MultiEdit|NotebookEdit)
    FILE_PATH="$(jq -r '.file_path // .path // .notebook_path // empty' <<<"$TOOL_INPUT")"
    if path_is_sensitive "$FILE_PATH"; then
      block "tool '$TOOL_NAME' targets sensitive path: $FILE_PATH"
    fi

    # On Write/Edit, also scan the *content* being written for accidentally
    # pasted secrets (an agent regenerating a config from memory, etc.)
    if [[ "$TOOL_NAME" =~ ^(Write|Edit|MultiEdit)$ ]]; then
      CONTENT="$(jq -r '.content // .new_string // (.edits[]? .new_string) // empty' <<<"$TOOL_INPUT")"
      if [[ -n "$CONTENT" ]] && command -v gitleaks >/dev/null 2>&1; then
        if ! echo "$CONTENT" | gitleaks stdin --no-banner --redact --exit-code 1 >/dev/null 2>&1; then
          block "content written to $FILE_PATH appears to contain a secret (gitleaks). Use a vault reference instead (op:// or bws)."
        fi
      fi
    fi
    ;;

  Bash)
    CMD="$(jq -r '.command // empty' <<<"$TOOL_INPUT")"
    [[ -z "$CMD" ]] && exit 0

    # 2a. Block reads of sensitive paths via shell (the path filter above
    # only catches the Read tool; `cat ~/.ssh/id_ed25519` would otherwise
    # slip through).
    READ_CMDS='(cat|less|more|head|tail|bat|xxd|od|strings|grep|rg|ag|awk|sed|sort|uniq|wc|file|stat|md5sum|sha[0-9]+sum|cp|mv|tar|zip|rsync|scp)'
    if [[ "$CMD" =~ ^[[:space:]]*$READ_CMDS[[:space:]] ]] || \
       [[ "$CMD" =~ [[:space:]]$READ_CMDS[[:space:]] ]]; then
      # extract path-looking tokens and check each
      while IFS= read -r token; do
        if path_is_sensitive "$token"; then
          block "Bash command would read sensitive path '$token': $CMD"
        fi
      done < <(grep -oE '(~|\$HOME|/)[A-Za-z0-9._/~-]+' <<<"$CMD" || true)
    fi

    # 2b. Block exfiltration channels — outbound network with payload.
    # Heuristic: any of these binaries combined with a sensitive path
    # token, *or* with stdin from a sensitive file, is almost always exfil.
    EXFIL_CMDS='(curl|wget|nc|ncat|socat|dig|nslookup|host|ssh|scp|sftp|ftp|rsync)'
    if [[ "$CMD" =~ $EXFIL_CMDS ]]; then
      # any sensitive token anywhere in the command
      while IFS= read -r token; do
        if path_is_sensitive "$token"; then
          block "Bash command appears to exfiltrate '$token': $CMD"
        fi
      done < <(grep -oE '(~|\$HOME|/)[A-Za-z0-9._/~-]+' <<<"$CMD" || true)

      # DNS-tunnel pattern from CVE-2025-55284 — base64 of a file as a
      # subdomain of a lookup target
      if [[ "$CMD" =~ (nslookup|dig|host).*\$\(.*base64.*\) ]]; then
        block "Bash command matches the DNS-exfil pattern (CVE-2025-55284): $CMD"
      fi
    fi

    # 2c. Block destructive blockchain ops outright. These should never be
    # autonomous. Belt-and-suspenders with the deny-list.
    BLOCKCHAIN_DESTRUCTIVE='(cast send|cast wallet|forge create|forge script.*--broadcast|hardhat run.* --network (mainnet|polygon|arbitrum|optimism|base))'
    if [[ "$CMD" =~ $BLOCKCHAIN_DESTRUCTIVE ]]; then
      block "Bash command performs an on-chain action — not allowed via agent: $CMD"
    fi

    # 2d. Block package publishing
    if [[ "$CMD" =~ (npm|yarn|pnpm|cargo|twine)[[:space:]]+publish ]]; then
      block "Bash command would publish a package — not allowed via agent: $CMD"
    fi

    # 2e. Block git operations that rewrite shared history
    if [[ "$CMD" =~ git[[:space:]]+push[[:space:]]+(--force|-f([[:space:]]|$)) ]]; then
      block "Bash command would force-push: $CMD"
    fi

    audit "$CMD"
    ;;

  WebFetch|WebSearch)
    # No secret-scanning relevance, but log for audit
    URL="$(jq -r '.url // .query // empty' <<<"$TOOL_INPUT")"
    audit "$URL"
    ;;

  *)
    # Unknown tool — allow but log
    audit "(unhandled tool)"
    ;;
esac

exit 0
