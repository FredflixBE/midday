-- Stubs for what Supabase provides and a vanilla Postgres does not.
-- Everything else a fresh database needs before `drizzle-kit push` comes from
-- the real bootstrap file, packages/db/supabase/00-bootstrap.sql, which the
-- test setup applies first. Tables, enums and indexes come from the push.

-- The roles RLS policies are granted to. Without them every CREATE POLICY
-- that names a role fails with `role "authenticated" does not exist`.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    CREATE ROLE anon NOLOGIN NOINHERIT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    CREATE ROLE authenticated NOLOGIN NOINHERIT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    CREATE ROLE service_role NOLOGIN NOINHERIT BYPASSRLS;
  END IF;
END
$$;

-- Supabase Auth's schema. Only the users table and only the columns the app
-- schema references: public.users.id is a foreign key onto auth.users.id.
CREATE SCHEMA IF NOT EXISTS auth;

CREATE TABLE IF NOT EXISTS auth.users (
  id uuid PRIMARY KEY
);

CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid
  LANGUAGE sql AS $$ SELECT '00000000-0000-0000-0000-000000000000'::uuid $$;

CREATE OR REPLACE FUNCTION auth.jwt() RETURNS jsonb
  LANGUAGE sql AS $$ SELECT '{}'::jsonb $$;
