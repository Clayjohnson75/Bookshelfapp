# Secret scans: commands and how to run them

**Question:** Are any secrets in the repo or git history?

Run these three scans locally (this environment does not have `rg` or `gitleaks` installed). Below: exact commands, then (A) results from a grep-based scan of the working tree.

---

## Commands to run locally

### A. Scan current working tree (fast grep)

```bash
rg -n --hidden --no-ignore-vcs \
  "(SUPABASE_SERVICE_ROLE_KEY|SERVICE_ROLE|OPENAI_API_KEY|GEMINI_API_KEY|QSTASH_|UPSTASH_|APPLE_SHARED_SECRET|RESEND|EMAIL_API_KEY|GOOGLE_BOOKS_API_KEY|sk-[A-Za-z0-9]{20,}|ghp_[A-Za-z0-9]{20,}|AIza[0-9A-Za-z_-]{20,}|AKIA[0-9A-Z]{16}|postgres:\/\/|-----BEGIN)" .
```

Requires: `ripgrep` (`brew install ripgrep`).

---

### B. Gitleaks on current source

```bash
gitleaks detect --source . --no-banner --redact
```

Requires: [gitleaks](https://github.com/zricethezav/gitleaks) (`brew install gitleaks`).

---

### C. Gitleaks on git history (the big one)

```bash
gitleaks detect --no-banner --redact --log-opts="--all"
```

If history is clean, you're in a great spot. **If anything shows up once, rotate that key.**

---

## One-shot script (all three + save outputs)

```bash
bash scripts/run-secret-scans.sh
```

Writes to `docs/secret-scan-outputs/` (gitignored):  
`A-working-tree-rg.txt`, `B-gitleaks-source.txt`, `C-gitleaks-history.txt`.

---

## A. Working-tree scan — full output (grep-based)

Scanned with the same patterns as the `rg` command (excluding `node_modules`, `dist`, `.git`). **Every match below is an env var name or a reference** (e.g. `process.env.SUPABASE_SERVICE_ROLE_KEY`). **No literal key values** (no `sk-...`, `ghp_...`, `AIza...`, `AKIA...`, `postgres://...`, or `-----BEGIN`).

### Matches by pattern

- **SUPABASE_SERVICE_ROLE_KEY / SERVICE_ROLE:** api/delete-pending-scan.ts, api/test.ts, api/books/enrich-batch.ts, docs/ENV_AUDIT_REPORT.md, api/update-password.ts, api/get-username.ts, api/books/enrich-description.ts, api/get-email-by-username.ts, api/debug/book-counts.ts, docs/REPO_SECRET_SCAN_REPORT.md, api/batch-status.ts, docs/BUNDLE_SECRET_CHECK.md, api/validate-apple-receipt.ts, api/google-books.ts, api/clear-library.ts, api/scan-job.ts, api/photo-invariant.ts, api/scan-status.ts, api/client-telemetry.ts, docs/SUPABASE_KEY_HYGIENE.md, api/scan-cancel.ts, api/scan.ts, api/password-reset.ts, lib/workers/metaEnrich.ts, api/send-confirmation-email.ts, api/register-cover-book.ts, api/update-username.ts, api/check-email-exists.ts, api/scan-worker.ts, api/import-guest-pending.ts, api/scan-delete.ts, docs/ROTATION_PLAN.md, api/profile/[username]/edit.ts, api/audit-event.ts, fix-localhost.sh, api/photo-scan-failed.ts, api/cover-status.ts, api/repair-dangling-photos.ts, api/scan-reaper.ts, api/scan-mark-imported.ts, api/library-books.ts, api/public-profile/[username].ts, api/set-favorites.ts, scripts/reset-dev-passwords.ts, api/admin/user-stats.ts, api/undo-delete.ts, lib/coverResolution.ts, api/scan/[jobId].ts — all `process.env.SUPABASE_SERVICE_ROLE_KEY` or comments/docs.
- **OPENAI_API_KEY, GEMINI_API_KEY, GOOGLE_BOOKS_API_KEY:** docs/ENV_AUDIT_REPORT.md, api/google-books.ts, services/googleBooksService.ts, api/library/ask.ts, docs/*, api/scan.ts, lib/enrichBookMetadata.ts, lib/enrichDescription.ts, api/auto-sort-books.ts, api/generate-avatar.ts, lib/coverResolution.ts — all `process.env.*` or doc references.
- **QSTASH_, UPSTASH_, APPLE_SHARED_SECRET, RESEND, EMAIL_API_KEY:** api/scan-job.ts, api/validate-apple-receipt.ts, api/send-password-reset.ts, lib/rateLimit.ts, docs/ROTATION_PLAN.md, api/scan.ts, api/scan-worker.ts, lib/coverRateLimit.ts, api/send-confirmation-email.ts, lib/enqueueCoverResolve.ts, api/cover-resolve-worker.ts, api/qstash-test.ts, docs/* — all env reads or comments.
- **Literal keys (sk-, ghp_, AIza..., AKIA..., postgres://, -----BEGIN):** **No matches** in repo (only in docs as “none found” and in scripts/run-secret-scans.sh as the regex).

**Conclusion (A):** No literal secrets in the working tree. Only env var names and `process.env` reads. No hardcoded keys.

---

## B and C — run locally and interpret

- **B (gitleaks current source):** Expect exit 0 if clean. Any finding = treat as secret and remove/rotate.
- **C (gitleaks history):** Same. If a secret appears in any commit, rotate that key and consider history rewrite (see docs/SECRET_SCANNING_SETUP.md).

After running B and C, paste or attach the full outputs here (or into `docs/secret-scan-outputs/`) to confirm “no secrets in repo or history” or to act on findings.
