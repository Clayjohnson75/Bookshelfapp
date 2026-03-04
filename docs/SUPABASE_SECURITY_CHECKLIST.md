# Supabase security checklist

Settings that must be configured in the **Supabase Dashboard** (no config.toml / code equivalent). Use this for new projects and when auditing existing ones.

---

## Auth: Leaked password protection (auth_leaked_password_protection, WARN)

**What:** Supabase can check new and changed passwords against known-compromised password lists (e.g. **HaveIBeenPwned**) to reduce credential stuffing and weak/reused passwords. This is a good hardening step.

**Where:** Dashboard → **Authentication** → **Providers** (or **Settings** / **Security**, depending on UI) → enable **Leaked Password Protection**. Turn it on if your plan supports it.

**Priority:** Medium. Not an exploit by itself; good baseline protection. Turning it on addresses the advisor finding. **Enable it when available.**

---

## Exposed schemas

Ensure only intended schemas are exposed to the API (Dashboard → **Project Settings** → **API** → **Exposed schemas**). Do **not** expose `private` (or any schema used for admin-only views like `user_activity_stats`).

---

## Optional

- **Rate limiting** for auth endpoints (if available in your plan).
- **Email confirmations** and **password requirements** under Auth settings.
