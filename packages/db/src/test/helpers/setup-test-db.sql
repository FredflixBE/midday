-- Stubs for what Supabase Auth provides and a vanilla Postgres does not.
-- Everything else a fresh database needs before `drizzle-kit push` comes from
-- the real bootstrap file, packages/db/supabase/00-bootstrap.sql, which the
-- test setup applies first. Tables, enums and indexes come from the push.

CREATE SCHEMA IF NOT EXISTS auth;

CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid
  LANGUAGE sql AS $$ SELECT '00000000-0000-0000-0000-000000000000'::uuid $$;

CREATE OR REPLACE FUNCTION auth.jwt() RETURNS jsonb
  LANGUAGE sql AS $$ SELECT '{}'::jsonb $$;
