# Secret scanning setup

To keep the repo "secure forever," we use secret scanning in two places: **pre-commit** (gitleaks locally on every commit) and **CI** (gitleaks on every PR and push to main). **Hard rule:** Nothing except safe config goes into expo.extra or EXPO_PUBLIC_* (see [FOREVER_SECURE_PLAYBOOK.md](FOREVER_SECURE_PLAYBOOK.md)).

## 1. Pre-commit scanning (recommended)

Prevent commits that contain secrets from being created in the first place.

### Option A: Gitleaks with pre-commit framework

1. **Install gitleaks** (one-time):
   - macOS: `brew install gitleaks`
   - Or: https://github.com/zricethezav/gitleaks#installation

2. **Install pre-commit** (one-time):
   ```bash
   pip install pre-commit
   # or: brew install pre-commit
   ```

3. **Install the git hook** (one-time, in repo root):
   ```bash
   pre-commit install
   ```
   This registers the gitleaks hook so it runs on **staged files** before each commit and blocks the commit if secrets are found.

4. **Confirm it's installed:** After `pre-commit install`, the hook runs automatically on `git commit`. To verify once:
   ```bash
   pre-commit run --all-files   # runs all hooks (e.g. gitleaks) on the whole repo
   ```
   If gitleaks is on PATH and finds no secrets, the run succeeds.

6. **Run manually** (optional):
   ```bash
   gitleaks detect
   # or scan only staged files:
   gitleaks protect --staged
   ```

The repo includes `.pre-commit-config.yaml` that runs **gitleaks protect --staged** (scans only staged files) on every commit. If gitleaks finds a secret, the commit is **blocked** before it enters git.

### Option B: npm script only (no hook)

If you prefer not to use the pre-commit framework:

1. Install gitleaks (see above).
2. Before pushing, run:
   ```bash
   npm run secret-scan
   ```
   This runs `gitleaks detect` (see `package.json` scripts). Add this to your workflow or run it in CI only.

## 2. CI scanning (blocks merges)

The workflow **`.github/workflows/ci.yml`** runs on **every push and pull request** to `main`/`master` (and `workflow_dispatch`). This **blocks merges** if secrets are found. It includes:

1. **Gitleaks** — Scans the repo (full history with `fetch-depth: 0`). Fails if secrets are detected.
2. **Bundle scan** — Builds web (`npx expo export --platform web`), then runs `scripts/ci-bundle-scan.sh` to grep `dist/` for inlined secrets (e.g. `sk-*`, `ghp_*`). Fails if any are found.
3. **.env guardrails** — Verifies `.gitignore` contains `.env` rules and that no `.env` file is tracked.

No extra setup required. If gitleaks finds secrets in **history**, see "If a secret was committed in the past" below; consider `git filter-repo` or BFG to remove from history (and rotate the secret).

## 3. .env and .gitignore

- **Never commit** `.env`, `.env.local`, or any `.env*` that contains real keys.
- `.gitignore` already includes:
  - `.env`
  - `.env*.local`
  - `.env*`
- Use **`.env.example`** as a template (no values). Copy to `.env` and fill in locally; keep `.env` out of version control.

## 4. One-liner audit (full history + dangerous patterns)

For a one-shot “forever” audit (e.g. before merge or periodically):

```bash
gitleaks detect --redact --log-opts="--all"
rg -n --no-ignore-vcs 'EXPO_PUBLIC_.*KEY|SERVICE_ROLE' .
```

Or run the script: `npm run audit-secrets` (or `bash scripts/audit-secrets-forever.sh`). The script runs gitleaks on full history and greps for EXPO_PUBLIC_.*KEY|SERVICE_ROLE; exit 1 if gitleaks finds anything.

## 5. If a secret was committed in the past (rotate + optional history rewrite)

- Rotate the secret immediately (Supabase, API keys, etc.).
- Remove it from history if necessary (see below); prefer rotating over rewriting history for shared branches.
- Ensure the same secret never appears again (pre-commit + CI will catch re-introduction).

**Optional — remove secret from repo history (use with care):**

- **git filter-repo** (recommended): Install (`pip install git-filter-repo` or [GitHub](https://github.com/newren/git-filter-repo)), then run from repo root:
  - Replace a specific string (e.g. leaked key):  
    `git filter-repo --replace-text <(echo 'LEAKED_KEY==>REDACTED') --force`
  - Or use a file listing replacements. **Warning:** Rewrites history; all clones need to re-fetch/rebase.
- **BFG Repo-Cleaner:** Alternative; see [BFG](https://rtyley.github.io/bfg-repo-cleaner/). Then `git reflog expire --expire=now --all && git gc --prune=now --aggressive`.
- After rewriting: force-push only if you own the branch and coordinate with team; rotate the secret regardless.
