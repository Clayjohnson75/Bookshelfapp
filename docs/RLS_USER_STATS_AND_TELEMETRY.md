# RLS: user_stats and client_telemetry (no always-true policies)

**Advisor warning:** `rls_policy_always_true` — an INSERT policy with `WITH CHECK (true)` can allow any role to insert rows for other users. That must never be used for user-scoped tables.

---

## user_stats

**Intent:** Normal users may only read/insert/update/delete **their own** row (`auth.uid() = user_id`). Any “system-wide” or bulk update is done via the **server using the service role** (bypasses RLS), or via a locked-down RPC that checks auth.

**Exact policy SQL** (from `enable-rls-public-tables.sql`):

```sql
-- Drop any existing permissive/broad policies first, then:
CREATE POLICY "user_stats_own_row_only" ON user_stats
  FOR ALL TO authenticated
  USING (user_id = (select auth.uid()))
  WITH CHECK (user_id = (select auth.uid()));
```

- **SELECT/UPDATE/DELETE:** only rows where `user_id = (select auth.uid())`.
- **INSERT:** only allowed when `user_id` in the new row equals `(select auth.uid())` — so users cannot insert a row for another user.
- **anon:** no policy → no access.
- **service_role:** bypasses RLS; used by API (e.g. clear-library, admin) for server-side updates.

---

## client_telemetry

**Intent:** Client can **insert** events only for themselves (or pre-login with `user_id IS NULL`). No SELECT/UPDATE/DELETE for anon/authenticated; only service role reads.

**Exact policy SQL** (from `enable-rls-public-tables.sql`):

```sql
CREATE POLICY "telemetry_insert_only" ON client_telemetry
  FOR INSERT TO anon
  WITH CHECK (user_id IS NULL);

CREATE POLICY "telemetry_insert_authenticated_own" ON client_telemetry
  FOR INSERT TO authenticated
  WITH CHECK (user_id IS NULL OR user_id = (select auth.uid())::text);
```

So: no `WITH CHECK (true)`. Authenticated users can only insert rows where `user_id` is their own id or null.

---

## auth_rls_initplan (performance)

All policies above use `(select auth.uid())` (scalar subquery), not bare `auth.uid()`, so Postgres evaluates it once per statement (initplan) instead of per row. Keep this pattern for any new RLS policies.
