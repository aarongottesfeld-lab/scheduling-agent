-- MCP OAuth tokens — stores access tokens issued to AI clients on behalf of Rendezvous users.
CREATE TABLE IF NOT EXISTS mcp_tokens (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  access_token  text NOT NULL UNIQUE,
  client_id     text NOT NULL,
  scope         text NOT NULL DEFAULT 'read_write',
  created_at    timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz NOT NULL DEFAULT now() + interval '24 hours',
  last_used_at  timestamptz
);

CREATE INDEX IF NOT EXISTS mcp_tokens_user_id_idx ON mcp_tokens(user_id);
CREATE INDEX IF NOT EXISTS mcp_tokens_access_token_idx ON mcp_tokens(access_token);

-- RLS
ALTER TABLE mcp_tokens ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users can view own tokens"
  ON mcp_tokens FOR SELECT USING (user_id = (SELECT auth.uid()));
CREATE POLICY "Service role full access"
  ON mcp_tokens FOR ALL USING (true);
