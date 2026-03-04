#!/usr/bin/env bash
# "Secure forever" one-shot audit: gitleaks (full history) + grep for dangerous EXPO_PUBLIC_ / SERVICE_ROLE.
# Use for: pre-merge check, periodic audit, after onboarding. Exit 0 = clean, 1 = findings.
# Requires: gitleaks (brew install gitleaks). Optional: rg for grep (else uses grep).
set -e

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

FAIL=0

echo "[AUDIT] 1. Gitleaks (full git history, redacted)"
echo "  Run: gitleaks detect --redact --log-opts=\"--all\""
if command -v gitleaks &>/dev/null; then
  if ! gitleaks detect --no-banner --redact --log-opts="--all" 2>&1; then
    echo "[AUDIT] FAIL: gitleaks found secrets in repo or history. Rotate any leaked key."
    FAIL=1
  fi
else
  echo "[AUDIT] SKIP: gitleaks not installed (brew install gitleaks)"
  FAIL=1
fi

echo ""
echo "[AUDIT] 2. Grep: EXPO_PUBLIC_.*KEY|SERVICE_ROLE (must be references only, no literal keys in repo)"
PATTERN='EXPO_PUBLIC_.*KEY|SERVICE_ROLE'
if command -v rg &>/dev/null; then
  HITS=$(rg -n --no-ignore-vcs "$PATTERN" . 2>/dev/null | grep -v '^\./node_modules/' | grep -v '^\./dist/' | grep -v '^\./\.git/' || true)
else
  HITS=$(grep -rn --include='*' -E "$PATTERN" . 2>/dev/null | grep -v 'node_modules/' | grep -v '/dist/' | grep -v '\.git/' || true)
fi
if [ -n "$HITS" ]; then
  echo "$HITS"
  echo ""
  echo "[AUDIT] Review above: only env *names* (e.g. process.env.SUPABASE_SERVICE_ROLE_KEY) are OK."
  echo "  Literal key values or EXPO_PUBLIC_* containing secrets = FAIL. Add to .env.example only (no values)."
  # Don't auto-fail on pattern match; many are safe references. Optional: add --strict to fail on any match.
  if [ "${AUDIT_STRICT:-0}" = "1" ]; then
    FAIL=1
  fi
else
  echo "  No matches."
fi

echo ""
if [ $FAIL -eq 1 ]; then
  echo "[AUDIT] Result: FAIL (fix gitleaks findings or install gitleaks)."
  exit 1
fi
echo "[AUDIT] Result: OK (history clean; review grep output if any)."
exit 0
