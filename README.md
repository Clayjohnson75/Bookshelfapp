# Bookshelf Scanner (Expo)

Expo/React Native app for scanning and cataloging books with a Supabase backend and Vercel API.

## Security and secret scanning

- **Never commit secrets.** Use `.env` for local config (see `.env.example`). Ensure `.env` and `.env*.local` are gitignored (they are).
- **Pre-commit:** Run `pre-commit install` once after clone so gitleaks scans staged files before each commit (blocks commits that contain secrets). See [docs/SECRET_SCANNING_SETUP.md](docs/SECRET_SCANNING_SETUP.md).
- **CI:** Secret scan (gitleaks), bundle scan after web build, and .env guardrails run on every push and PR to `main`/`master` (`.github/workflows/ci.yml`). The build fails if secrets are detected or if the bundle contains inlined keys (e.g. `sk-*`, `ghp_*`).
- **Env audit:** Client vs server env usage is documented in [docs/ENV_AUDIT_REPORT.md](docs/ENV_AUDIT_REPORT.md). Supabase key usage and RLS are in [docs/SUPABASE_KEY_HYGIENE.md](docs/SUPABASE_KEY_HYGIENE.md).

**Full reference:** [docs/APP_AND_SECURITY_REFERENCE.md](docs/APP_AND_SECURITY_REFERENCE.md) — single doc with app architecture, auth, data model, scan flow, library/approve, every API route, and complete security (keys, RLS, bundle scan, secrets, deployment).

Quick local scan:

```bash
npm run secret-scan   # requires gitleaks: brew install gitleaks
```
