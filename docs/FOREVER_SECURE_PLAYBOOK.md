# “Forever secure” playbook: how to verify keys aren’t exposed

Four layers to keep secrets out of the repo, out of client builds, out of logs/responses, and behind proper access control.

**Hard rule:** Nothing except safe config goes into **expo.extra** or **EXPO_PUBLIC_***. Allowed in extra: `supabaseUrl`, `supabaseAnonKey`, `EXPO_PUBLIC_API_BASE_URL`, `eas` (projectId). Never: any key, secret, or `EXPO_PUBLIC_*` whose value is a secret (e.g. `EXPO_PUBLIC_SUPABASE_SERVICE_ROLE_KEY`). Enforced by [docs/CLIENT_BUNDLE_SECRET_CHECK.md](CLIENT_BUNDLE_SECRET_CHECK.md), `scripts/ci-client-secret-check.sh`, and code review.

---

## Layer 1: Repo scanning (pre-commit + CI)

**Goal:** Block commits that contain secrets and fail CI when they appear.

| What | Status in this repo |
|------|----------------------|
| **CI gitleaks** | **Every PR + push to main/master.** `.github/workflows/ci.yml` runs gitleaks (full history); **blocks merges** if secrets found. Uses `gitleaks/gitleaks-action@v2`. |
| **Pre-commit gitleaks** | **Locally on every commit.** `.pre-commit-config.yaml` runs `gitleaks protect --staged`. Run **`pre-commit install`** once after clone. Requires: `brew install gitleaks`, `pip install pre-commit`. |
| **npm** | `npm run secret-scan` = gitleaks current tree. `npm run audit-secrets` = full audit (history + grep). |

**Verify:** Run `npm run secret-scan` and `pre-commit run --all-files`. For a one-shot “forever” audit (history + dangerous patterns), run the one-liners below or `npm run audit-secrets`.

**One-liner audit:**
```bash
gitleaks detect --redact --log-opts="--all"
rg -n --no-ignore-vcs 'EXPO_PUBLIC_.*KEY|SERVICE_ROLE' .   # or grep -rn -E 'EXPO_PUBLIC_.*KEY|SERVICE_ROLE' . (exclude node_modules/dist/.git)
```
Or: `bash scripts/audit-secrets-forever.sh` (same checks; exits 1 if gitleaks finds anything).

**Docs:** [docs/SECRET_SCANNING_SETUP.md](SECRET_SCANNING_SETUP.md), [README.md](../README.md) (Security section).

---

## Layer 2: Client bundle scanning (what actually ships)

**Goal:** Even if the repo is clean, confirm that **built** artifacts (Expo/RN bundle, web build) do not contain secret values or dangerous references.

| What to scan | Where | How often |
|--------------|--------|-----------|
| **Expo web** | `dist/` after `npx expo export --platform web` | Before release; optionally in CI. |
| **Native bundles** | EAS build artifacts (e.g. downloaded JS bundle) if you want to scan them | Before store submit. |
| **Other** | Any `build/`, `.next/` if you add Next.js | On each build. |

**Patterns to grep for (no values should appear):**  
`SUPABASE_SERVICE_ROLE_KEY`, `service_role`, `sk-`, `OPENAI_API_KEY`, `GEMINI_API_KEY`, `GOOGLE_BOOKS_API_KEY`, `QSTASH_TOKEN`, `APPLE_SHARED_SECRET`, `EMAIL_API_KEY`, raw JWT (eyJ...) **except** the Supabase anon key (that one is intended to be public).

**Status:** [docs/BUNDLE_SECRET_CHECK.md](BUNDLE_SECRET_CHECK.md) documents the last web-bundle scan. No secret **values** were in the bundle; the **name** and code path for `SUPABASE_SERVICE_ROLE_KEY` appear in `services/googleBooksService.ts` (server branch bundled for web). Recommendation: remove that server-only path from the client bundle (e.g. API-only or conditional import).

**Action:** Re-run bundle scan after major changes or before each release; add a CI step that runs `expo export --platform web` and greps `dist/` for the patterns above if you want automation.

---

## Layer 3: Runtime logging / telemetry guardrails

**Goal:** Server never returns debug objects that mention key presence, length, or prefixes. Redact secrets in logs.

| Do | Don’t |
|----|--------|
| Redact or omit API keys, tokens, and secrets from log payloads. | Log `keyLength`, `hasKey`, `serviceKeyPrefix`, or any slice of a secret. |
| Use generic error messages to the client (“Server configuration error”). | Send `hasKey: true`, `keyLength: 48`, or key prefixes in HTML/JSON responses. |
| Keep sensitive debug only in server logs and restrict log access. | Rely on “we only log in dev” without guarding production logs. |

**Good:** [api/client-telemetry.ts](api/client-telemetry.ts) redacts `authorization`, `api_key`, `bearer`, `jwt`, etc. from headers. [lib/securityBaseline.ts](lib/securityBaseline.ts) and [lib/authIntegrity.ts](lib/authIntegrity.ts) document “never log JWTs / full tokens.” Keep that standard for any new logging.

---

## Layer 4: Access control posture

**Goal:** Treat the anon key as public; lock down everything with RLS and least privilege; remove dangerous fallbacks that could encourage putting secrets in `EXPO_PUBLIC_*`.

| Do | Don’t |
|----|--------|
| Use **anon** key only in client and in server auth flows; protect data with **RLS** and `(select auth.uid())`. | Put **service_role** or any secret in client code or in `expo.extra`. |
| Use **service_role** only in server-side API/workers/scripts with env-based secrets (e.g. Vercel env). | Fall back to `EXPO_PUBLIC_SUPABASE_SERVICE_ROLE_KEY` or any `EXPO_PUBLIC_*` secret. |
| Keep `app.config.js` **extra** to: `supabaseUrl`, `supabaseAnonKey`, `EXPO_PUBLIC_API_BASE_URL`, `eas`. | Add `GOOGLE_BOOKS_API_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, or other secrets to **extra**. |

**Docs:** [docs/SUPABASE_KEY_HYGIENE.md](SUPABASE_KEY_HYGIENE.md), [docs/ENV_AUDIT_REPORT.md](ENV_AUDIT_REPORT.md).

---

## Quick checklist

- [ ] Layer 1: Gitleaks in CI + pre-commit; `npm run secret-scan` clean.
- [ ] Layer 2: Bundle scan (dist/ and any build output) shows no secret values; optional: no `SUPABASE_SERVICE_ROLE_KEY` name/code path in client bundle.
- [ ] Layer 3: No `keyLength` / `serviceKeyPrefix` / key prefixes in logs or responses; secrets redacted in telemetry.
- [ ] Layer 4: Anon key only in client; service role only server-side; no `EXPO_PUBLIC_*` fallbacks for secrets; RLS on all exposed tables.

**More:** Key rotation (any suspected leak = rotate immediately): [docs/ROTATION_PLAN.md](ROTATION_PLAN.md). Supabase RLS and advisor fixes: [docs/RLS_USER_STATS_AND_TELEMETRY.md](RLS_USER_STATS_AND_TELEMETRY.md), [docs/SUPABASE_WARNINGS_EXPLAINED.md](SUPABASE_WARNINGS_EXPLAINED.md). Auth: enable Leaked Password Protection in Dashboard when your plan supports it ([docs/SUPABASE_SECURITY_CHECKLIST.md](SUPABASE_SECURITY_CHECKLIST.md)).
