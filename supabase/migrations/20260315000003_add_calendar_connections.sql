CREATE TABLE IF NOT EXISTS calendar_connections (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  provider       text NOT NULL CHECK (provider IN ('google', 'apple')),
  account_label  text,
  account_email  text,
  tokens         jsonb,
  calendar_ids   text[] DEFAULT '{}',
  is_primary     boolean NOT NULL DEFAULT false,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

-- Index for the most common query pattern: all connections for a user
CREATE INDEX IF NOT EXISTS idx_calendar_connections_user_id
  ON calendar_connections (user_id);

-- Auto-update updated_at on any row change
CREATE OR REPLACE FUNCTION update_calendar_connections_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER calendar_connections_updated_at
  BEFORE UPDATE ON calendar_connections
  FOR EACH ROW EXECUTE FUNCTION update_calendar_connections_updated_at();

-- RLS
ALTER TABLE calendar_connections ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can read their own calendar connections"
  ON calendar_connections FOR SELECT
  USING (user_id = auth.uid());

CREATE POLICY "Users can insert their own calendar connections"
  ON calendar_connections FOR INSERT
  WITH CHECK (user_id = auth.uid());

CREATE POLICY "Users can update their own calendar connections"
  ON calendar_connections FOR UPDATE
  USING (user_id = auth.uid());

CREATE POLICY "Users can delete their own calendar connections"
  ON calendar_connections FOR DELETE
  USING (user_id = auth.uid());

-- Service role policy (needed for server-side reads using service role key)
CREATE POLICY "Service role has full access to calendar_connections"
  ON calendar_connections FOR ALL
  USING (auth.role() = 'service_role');
