-- Enable RLS on tables that were previously unprotected.
-- Both tables are written exclusively via API routes using the service role key,
-- so no direct client access is needed. Restricting all direct access ensures
-- that leaked anon keys cannot read or write these tables.

-- client_telemetry: only service role (via API routes) may insert or select.
ALTER TABLE client_telemetry ENABLE ROW LEVEL SECURITY;
CREATE POLICY "telemetry_no_direct_access" ON client_telemetry
  AS RESTRICTIVE
  FOR ALL
  USING (false);

-- book_metadata_cache: shared cache managed by service role only.
-- Authenticated users must not be able to delete or overwrite cache rows.
ALTER TABLE book_metadata_cache ENABLE ROW LEVEL SECURITY;
CREATE POLICY "cache_no_direct_access" ON book_metadata_cache
  AS RESTRICTIVE
  FOR ALL
  USING (false);
