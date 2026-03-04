# Supabase advisor warnings: what they mean and what’s worth fixing

This doc explains the Supabase project advisor / linter warnings you’re likely to see, whether each is security or performance, and what this repo has already done vs what’s left.

---

## A) function_search_path_mutable (SECURITY-ish)

**What it means:** If a function doesn’t pin `search_path`, Postgres resolves unqualified names (tables, functions) using the current `search_path`. That can be changed by a caller, so an attacker could get the function to use a malicious object from another schema (search_path hijacking). Risk is highest for **SECURITY DEFINER** functions (they run with the owner’s privileges).

**Fix pattern:**  
- Set an explicit `search_path` on the function, e.g. `pg_catalog, public`.  
- In function bodies, prefer schema-qualified names (`public.table_name`, `pg_catalog.now()`).

**Worth fixing?** Yes. Low effort, good practice for every function; required for SECURITY DEFINER.

**Status in this repo:** Addressed in `supabase-migrations/pin-function-search-path.sql`: all relevant functions have `SET search_path = pg_catalog, public`. If the advisor still reports other functions, add the same `ALTER FUNCTION ... SET search_path` for them.

---

## B) auth_rls_initplan (PERFORMANCE)

**What it means:** This is **not** a security bug. In RLS policies, using `auth.uid()` or `current_setting('request.jwt.claim.sub')` directly can be evaluated **per row**. Wrapping it as `(select auth.uid())` lets Postgres treat it as a single “init plan” (evaluated once per statement), which is faster. Supabase documents this pattern.

**Fix pattern:** In policy expressions, use `(select auth.uid())` instead of bare `auth.uid()`.

**Worth fixing?** Yes. Simple change, avoids unnecessary per-row work.

**Status in this repo:** Addressed in `supabase-migrations/enable-rls-public-tables.sql`: all RLS policies use `(select auth.uid())` (or equivalent) for user checks. If new policies are added, keep using this pattern.

---

## C) multiple_permissive_policies (PERFORMANCE + clarity)

**What it means:** Multiple **permissive** policies on the same table are OR’d together. That can slow planning/execution and make “who can do what” harder to reason about. It’s not a direct security bug, but redundant or overlapping policies increase complexity and can hide mistakes.

**Fix pattern:**  
- Consolidate “public X viewable by everyone” into one policy where possible.  
- For “users see only their own rows,” use one policy per action (SELECT, INSERT, UPDATE, DELETE) with a single condition, and remove duplicate policies that do the same thing.

**Worth fixing?** Yes. Cleaner and often faster.

**Status in this repo:** Addressed for `books` and `user_stats` in `enable-rls-public-tables.sql`: existing policies were dropped and replaced with one policy per action (books) or one policy for ALL (user_stats), authenticated only, own rows. If the advisor still flags other tables, audit with:

```sql
select policyname, polcmd, polroles, polqual, polwithcheck
from pg_policies
where schemaname = 'public' and tablename = 'your_table'
order by polcmd, policyname;
```

Then merge or drop redundant permissive policies.

---

## D) duplicate_index (PERFORMANCE / maintenance)

**What it means:** Two indexes on the same table have the same (or effectively the same) key columns. One is redundant; it wastes space and slows writes.

**Fix pattern:** Keep the primary key (or the index you rely on); drop the duplicate. Use `pg_indexes` to see index definitions and pick which name to drop.

**Worth fixing?** Yes. Reduces bloat and write cost.

**Status in this repo:** Addressed in `supabase-migrations/drop-cover-resolutions-duplicate-index.sql`: duplicate non-PK indexes on `cover_resolutions` are dropped, keeping the primary key. If the advisor reports other tables, run a similar audit and drop the redundant index by name.

---

## E) Leaked password protection disabled (SECURITY)

**What it means:** Supabase Auth can check new and changed passwords against known-compromised password lists (e.g. HaveIBeenPwned-style) to reduce credential stuffing and weak/reused passwords. If this is off, users can set passwords that are already known to be leaked.

**Fix pattern:** Enable in the Dashboard (no migration). Location varies by UI: **Authentication** → **Providers** or **Settings** / **Security** → enable **Leaked Password Protection** (and any password strength options your plan offers).

**Worth fixing?** Yes. Real security hardening with no code change.

**Status in this repo:** Documented in `docs/SUPABASE_SECURITY_CHECKLIST.md` as a manual Dashboard step. **Action:** In the Supabase project, turn on Leaked Password Protection if your plan supports it (uses HaveIBeenPwned-style checks). Enable strong password rules if available.

---

## Summary

| Warning                       | Type        | Worth fixing? | This repo |
|------------------------------|------------|----------------|-----------|
| **A** function_search_path   | Security   | Yes            | Fixed in `pin-function-search-path.sql`; add any new functions. |
| **B** auth_rls_initplan      | Performance| Yes            | Fixed in `enable-rls-public-tables.sql`; keep pattern for new policies. |
| **C** multiple_permissive    | Perf/clarity | Yes         | Fixed for `books` and `user_stats`; audit other tables if advisor flags them. |
| **D** duplicate_index        | Performance| Yes            | Fixed for `cover_resolutions`; repeat for any other reported tables. |
| **E** Leaked password protection | Security | Yes         | Dashboard only; see `SUPABASE_SECURITY_CHECKLIST.md` and enable it. |

**Priority order if you’re cleaning up:** E (quick security win) → A (any remaining functions) → C (any remaining tables) → D (any remaining indexes) → B (should already be done). All are worth doing; E and A have the clearest security impact.
