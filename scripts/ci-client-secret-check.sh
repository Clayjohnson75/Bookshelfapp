#!/usr/bin/env bash
# Fail if any server-only env var name appears in client code paths.
# Usage: bash scripts/ci-client-secret-check.sh

set -e
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

PATTERN='SUPABASE_SERVICE_ROLE_KEY|OPENAI_API_KEY|GEMINI_API_KEY|QSTASH_|UPSTASH_|APPLE_SHARED_SECRET|EMAIL_API_KEY|GOOGLE_BOOKS_API_KEY'
# Client-entry paths only (auth, components, screens, tabs, contexts, App, services).
# lib/ is not included: it is only imported by api/ and lib/workers, so not in client bundle.
SEARCH="auth components screens tabs contexts services App.tsx AppWrapper.tsx"
ALLOWLIST=""

if command -v rg &>/dev/null; then
  FOUND=""
  for path in $SEARCH; do
    [ ! -e "$path" ] && continue
    while IFS= read -r line; do
      file="${line%%:*}"
      [ -z "$file" ] && continue
      skip=0
      for a in $ALLOWLIST; do [[ "$file" == *"$a" ]] && skip=1 && break; done
      [ $skip -eq 1 ] && continue
      FOUND="$FOUND$line"$'\n'
    done < <(rg -n "$PATTERN" "$path" 2>/dev/null || true)
  done
else
  FOUND=$(grep -r -n -E "$PATTERN" $SEARCH 2>/dev/null || true)
  if [ -n "$FOUND" ]; then
    FOUND=$(echo "$FOUND" | while read -r line; do
      file="${line%%:*}"
      for a in $ALLOWLIST; do [[ "$file" == *"$a" ]] && exit 0; done
      echo "$line"
    done)
  fi
fi

if [ -n "$FOUND" ]; then
  echo "[CLIENT_SECRET_CHECK] FAIL: Server-only env names in client code paths:"
  echo "$FOUND"
  echo "See docs/CLIENT_BUNDLE_SECRET_CHECK.md"
  exit 1
fi

echo "[CLIENT_SECRET_CHECK] OK"
exit 0
