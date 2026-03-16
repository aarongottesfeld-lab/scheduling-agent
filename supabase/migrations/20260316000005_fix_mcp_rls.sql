-- A5-030 [HIGH]: Drop overly permissive "Service role full access" policy on mcp_tokens.
-- The service role bypasses RLS by default and does not need an explicit policy.
-- The USING (true) clause allowed ANY role (including anon) full access.
DROP POLICY IF EXISTS "Service role full access" ON mcp_tokens;

-- A5-031 [WARN]: Enable RLS on mcp_client_registrations.
-- Service role (used by MCP server) bypasses RLS automatically.
-- No anon access needed — /oauth/client-info uses the service role client.
ALTER TABLE mcp_client_registrations ENABLE ROW LEVEL SECURITY;
