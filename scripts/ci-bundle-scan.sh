#!/usr/bin/env bash
# Scan built web bundle for forbidden patterns. Fail if any match.
# Run after: npx expo export --platform web
# Scans: dist/_expo/static/js/web/*.js and *.js.map (if present).
# CI uses GENERATE_SOURCEMAP=false so .map files are not emitted; if you enable
# sourcemaps, do not deploy them publicly (they can expose source and env context).
#
# Forbidden patterns (env names / URL schemes that must never appear in client bundle):
#   SUPABASE_SERVICE_ROLE_KEY, EXPO_PUBLIC_SUPABASE_SERVICE_ROLE_KEY,
#   OPENAI_API_KEY, QSTASH_, GOOGLE_BOOKS_API_KEY, APPLE_SHARED_SECRET,
#   UPSTASH_REDIS_REST_TOKEN, sk- (OpenAI/Stripe-style keys), postgres://
set -e
DIST="${1:-dist}"
WEBDIR="$DIST/_expo/static/js/web"
if [[ ! -d "$WEBDIR" ]]; then
  echo "::error::Missing $WEBDIR (run 'npx expo export --platform web' first)"
  exit 1
fi
FAILED=0
# Build list of files to scan
FILES=()
for f in "$WEBDIR"/*.js "$WEBDIR"/*.js.map; do
  [[ -f "$f" ]] && FILES+=( "$f" )
done
if [[ ${#FILES[@]} -eq 0 ]]; then
  echo "::error::No .js or .js.map files in $WEBDIR"
  exit 1
fi
echo "Scanning ${#FILES[@]} file(s) in $WEBDIR for forbidden patterns..."

# Forbidden pattern list (one per line for clear error reporting)
PATTERNS=(
  'SUPABASE_SERVICE_ROLE_KEY'
  'EXPO_PUBLIC_SUPABASE_SERVICE_ROLE_KEY'
  'OPENAI_API_KEY'
  'QSTASH_'
  'GOOGLE_BOOKS_API_KEY'
  'APPLE_SHARED_SECRET'
  'UPSTASH_REDIS_REST_TOKEN'
  'sk-[A-Za-z0-9]{20,}'           # OpenAI/Stripe-style literal keys
  'postgres://'
  'postgresql://'
)

for pat in "${PATTERNS[@]}"; do
  if grep -lE "$pat" "${FILES[@]}" 2>/dev/null; then
    echo "::error::Forbidden pattern found in bundle: $pat"
    grep -nE "$pat" "${FILES[@]}" 2>/dev/null || true
    FAILED=1
  fi
done

if [[ $FAILED -eq 1 ]]; then
  echo "::error::Bundle scan failed: remove server-only secrets/patterns from client build."
  exit 1
fi
echo "Bundle scan OK: no forbidden patterns in $WEBDIR."
