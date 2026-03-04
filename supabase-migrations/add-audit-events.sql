-- ============================================================
-- audit_events: permanent server-side record of every destructive
-- operation so we can always answer "what deleted my stuff?"
--
-- Insert via POST /api/audit-event (service-role key).
-- Never modified after insert; deleted_at never set on this table.
-- ============================================================

CREATE TABLE IF NOT EXISTS audit_events (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID        NOT NULL,
  action_id     TEXT        NOT NULL,       -- del_<timestamp>_<rand6> from deleteGuard
  reason        TEXT        NOT NULL,       -- DeleteReason enum value
  screen        TEXT,                       -- screen/component that triggered
  book_ids      TEXT[],                     -- IDs of books affected (if any)
  photo_ids     TEXT[],                     -- IDs of photos affected (if any)
  book_count    INT         NOT NULL DEFAULT 0,
  photo_count   INT         NOT NULL DEFAULT 0,
  extra         JSONB       NOT NULL DEFAULT '{}',
  occurred_at   TIMESTAMPTZ NOT NULL,       -- client-side gestureAt timestamp
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Lookup by user for "what happened to my library?"
CREATE INDEX IF NOT EXISTS idx_audit_events_user_id
  ON audit_events (user_id, created_at DESC);

-- Lookup by action_id to correlate client + server logs
CREATE UNIQUE INDEX IF NOT EXISTS idx_audit_events_action_id
  ON audit_events (action_id);

-- RLS: only service role may insert; row owner may read their own rows.
ALTER TABLE audit_events ENABLE ROW LEVEL SECURITY;

-- Service role bypasses RLS; no explicit service-role policy needed.
-- App users can read their own audit trail.
CREATE POLICY "Users can read own audit events"
  ON audit_events FOR SELECT
  USING ((select auth.uid()) = user_id);

COMMENT ON TABLE audit_events IS
  'Permanent record of every destructive action (delete/bulk-delete) so we can '
  'always reconstruct what was deleted, by whom, and when.';
