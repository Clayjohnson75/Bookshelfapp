#!/usr/bin/env bash
# Run all three secret scans and write full outputs to docs/secret-scan-outputs/
# Requires: rg (ripgrep), gitleaks (brew install gitleaks / https://github.com/zricethezav/gitleaks)
# Usage: bash scripts/run-secret-scans.sh

set -e
OUTDIR="${1:-docs/secret-scan-outputs}"
mkdir -p "$OUTDIR"

echo "Outputs will be written to $OUTDIR/"
echo ""

# A. Fast grep (working tree)
echo "=== A. Scanning working tree (rg) ==="
if command -v rg &>/dev/null; then
  rg -n --hidden --no-ignore-vcs \
    '(SUPABASE_SERVICE_ROLE_KEY|SERVICE_ROLE|OPENAI_API_KEY|GEMINI_API_KEY|QSTASH_|UPSTASH_|APPLE_SHARED_SECRET|RESEND|EMAIL_API_KEY|GOOGLE_BOOKS_API_KEY|sk-[A-Za-z0-9]{20,}|ghp_[A-Za-z0-9]{20,}|AIza[0-9A-Za-z_-]{20,}|AKIA[0-9A-Z]{16}|postgres:\/\/|-----BEGIN)' . \
    > "$OUTDIR/A-working-tree-rg.txt" 2>&1 || true
  echo "Saved to $OUTDIR/A-working-tree-rg.txt"
  wc -l "$OUTDIR/A-working-tree-rg.txt"
else
  echo "rg not found. Install: brew install ripgrep"
  echo "Skipping A."
fi
echo ""

# B. Gitleaks current source
echo "=== B. Gitleaks (current source) ==="
if command -v gitleaks &>/dev/null; then
  gitleaks detect --source . --no-banner --redact > "$OUTDIR/B-gitleaks-source.txt" 2>&1 || true
  echo "Saved to $OUTDIR/B-gitleaks-source.txt"
  cat "$OUTDIR/B-gitleaks-source.txt"
else
  echo "gitleaks not found. Install: brew install gitleaks"
  echo "Skipping B."
fi
echo ""

# C. Gitleaks git history (the big one)
echo "=== C. Gitleaks (git history) ==="
if command -v gitleaks &>/dev/null; then
  gitleaks detect --no-banner --redact --log-opts="--all" > "$OUTDIR/C-gitleaks-history.txt" 2>&1 || true
  echo "Saved to $OUTDIR/C-gitleaks-history.txt"
  cat "$OUTDIR/C-gitleaks-history.txt"
else
  echo "gitleaks not found. Skipping C."
fi
echo ""
echo "Done. If history is clean, you're in a great spot. If anything shows up once, rotate that key."
