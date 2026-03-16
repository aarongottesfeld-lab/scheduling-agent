-- Stores dynamically registered OAuth clients (RFC 7591).
-- Populated by POST /register on the MCP server, queried by the consent page
-- to display a friendly client name instead of a raw hex client_id.
-- Rows expire after 24 hours; cleanup happens on read.

CREATE TABLE IF NOT EXISTS mcp_client_registrations (
  client_id     text PRIMARY KEY,
  client_name   text NOT NULL,
  redirect_uris jsonb NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz NOT NULL DEFAULT now() + interval '24 hours'
);
