-- A5-005 [INFO]: Update default expiry from 24 hours to 90 days to match
-- the actual token issuance in mcp/auth.js (line 279).
ALTER TABLE mcp_tokens
  ALTER COLUMN expires_at SET DEFAULT now() + interval '90 days';
