# Leaked secrets remediation (plan)

**Do not paste or commit real secret values in this doc.** Run the commands below locally; they print to your terminal only.

---

## 1) Confirm exactly what the matches are (run locally)

Run these to print the offending lines to your terminal only:

```bash
git show 4eece157d728:.env | nl -ba | sed -n '1,5p'
git show 4eece157d728:README.md | nl -ba | sed -n '20,35p'
git show dee37214224e:TEST_DEV_DATABASE.md | nl -ba | sed -n '35,55p'
git show dee37214224e:UPDATE_ENV_INSTRUCTIONS.md | nl -ba | sed -n '10,30p'
```

**Findings (summary, no values):**

- **4eece157d728 .env (lines 1–5):** Contains `EXPO_PUBLIC_OPENAI_API_KEY=sk-proj-...` and `EXPO_PUBLIC_GEMINI_API_KEY=AIzaSy...`. **Treat as compromised.** Rotate both.
- **4eece157d728 README.md (lines 20–35):** Same OpenAI key in a code block (setup instructions). **Compromised.**
- **dee37214224e TEST_DEV_DATABASE.md:** Dev Supabase URL and a publishable-style key (`sb_publishable_...`). Treat as compromised for that dev project.
- **dee37214224e UPDATE_ENV_INSTRUCTIONS.md:** Dev and production Supabase URLs, production anon JWT, API base URL. Production anon is designed to be public; still avoid committing. Dev credentials: treat as compromised.

If any of those show real keys (not placeholders), rotate them.

---

## 2) Rotate keys now (because they were in git history)

- **OpenAI:** Revoke the old key, create a new one, update Vercel / EAS / local envs.
- **GCP (Google Books / Gemini):** Rotate or restrict the key (API restrictions + HTTP referrer / IP where possible).
- **Supabase dev project:** Rotate anon key for the dev project if you care; restrict or rotate any other dev secrets.

---

## 3) Remove keys from repo current state

- **.env:** Already untracked (`.gitignore` has `.env` and `.env*`). If it were tracked:

  ```bash
  git rm --cached .env
  echo ".env" >> .gitignore
  echo ".env.*" >> .gitignore
  git add .gitignore
  git commit -m "Stop tracking .env; ignore env files"
  ```

- **Docs:** Real anon JWT was removed from `docs/BUILD_ARTIFACT_SCAN_REPORT.md` and `docs/BUNDLE_SECRET_CHECK.md` (replaced with `eyJ...REDACTED_ANON_KEY`). README at those commits had the OpenAI key; ensure current README has no real keys (use placeholders only).

---

## 4) Purge leaked secrets from git history

Rotation is the real fix. To remove leaked files from history as well:

**Option A: git-filter-repo (recommended)**

```bash
brew install git-filter-repo
git filter-repo --path .env --invert-paths
```

Then remove the README line(s) that contained keys. Either:

- Edit README.md in the repo to remove/placeholder the key, then (if you need to rewrite history for README too) use a replace-text pass, or
- Use `git filter-repo --replace-text <file>` where the file lists find/replace pairs (see git-filter-repo docs).

After rewriting history:

- Force-push the cleaned branches: `git push --force-with-lease origin main` (and any other branches).
- Optionally rotate keys again if you want to be extra cautious.

**Option B: BFG**

See BFG Repo-Cleaner docs to remove `.env` and optionally replace strings in README.

---

## 5) Reduce noise: allowlist Supabase anon JWT only where expected

- **Done:** `.gitleaks.toml` extends the default config (`[extend] useDefault = true`) and add an allowlist so only these paths are allowed to contain the Supabase anon JWT (or placeholder):
  - `app.config.js` (fallback anon key; public by design)
  - `.github/workflows/ci.yml` (placeholder anon in CI env)
- **CI:** The workflow uses `GITLEAKS_CONFIG: .gitleaks.toml` so gitleaks uses this allowlist. No other secrets are allowlisted.

Best practice: do not commit the real anon key in docs; use a placeholder. The allowlist is only so that the one expected use (app.config.js fallback and CI placeholder) does not fail the scan.
