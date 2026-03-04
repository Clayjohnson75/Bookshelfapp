-- Client telemetry for TestFlight/App Store observability. Short retention (e.g. delete older than 7 days via cron or TTL).
CREATE TABLE IF NOT EXISTS client_telemetry (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id TEXT,
  device_id TEXT,
  session_id TEXT,
  build TEXT,
  event_name TEXT NOT NULL,
  data JSONB DEFAULT '{}',
  ts TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_client_telemetry_created_at ON client_telemetry(created_at);
CREATE INDEX IF NOT EXISTS idx_client_telemetry_event_name ON client_telemetry(event_name);
CREATE INDEX IF NOT EXISTS idx_client_telemetry_user_id ON client_telemetry(user_id);

-- Optional: RLS so only service role can insert/select (client uses API with service key).
-- Application inserts via API route with SUPABASE_SERVICE_ROLE_KEY; no direct client access.
COMMENT ON TABLE client_telemetry IS 'High-signal client events for scan debugging in production. Retain last N days only.';
