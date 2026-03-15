-- A4-017: Drop the vestigial google_tokens table.
-- Audit 4 confirmed: zero rows, zero code references in server/, no FK dependents.
-- The 20260308000002 migration already wrapped its policies in IF EXISTS guards
-- anticipating this cleanup. CASCADE is safe — no other table references google_tokens.

DROP TABLE IF EXISTS public.google_tokens CASCADE;
