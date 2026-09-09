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

-- Supabase grants the API roles access to whatever is created in `public`,
-- through default privileges on the role that creates it. drizzle-kit pushes
-- as that role, so its tables arrive already granted. Setting the same default
-- here, before the push, is what makes RLS — rather than a missing GRANT —
-- decide what a request can see.
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT ALL ON TABLES TO anon, authenticated, service_role;
GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;

-- Supabase Auth's schema. Only the users table and only the columns the app
-- schema references: public.users.id is a foreign key onto auth.users.id.
CREATE SCHEMA IF NOT EXISTS auth;

CREATE TABLE IF NOT EXISTS auth.users (
  id uuid PRIMARY KEY
);

-- Reads the claim the same way Supabase's own auth.uid() does, so a test can
-- act as a given user with
--   set local request.jwt.claim.sub = '<uuid>'
-- and the policies see what they would see in production.
CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid
  LANGUAGE sql STABLE
  AS $$ SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;

CREATE OR REPLACE FUNCTION auth.jwt() RETURNS jsonb
  LANGUAGE sql STABLE
  AS $$ SELECT coalesce(
                 nullif(current_setting('request.jwt.claims', true), ''),
                 '{}'
               )::jsonb $$;

-- Supabase Storage's schema: the two tables the bucket policies read and the
-- path helper they call. Recovered from the same dump as the policies
-- (apps/api/supabase/migrations/20240917165404_remote_schema.sql).
CREATE SCHEMA IF NOT EXISTS storage;

CREATE TABLE IF NOT EXISTS storage.buckets (
  id text PRIMARY KEY,
  name text NOT NULL,
  public boolean DEFAULT false,
  file_size_limit bigint,
  allowed_mime_types text[],
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS storage.objects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bucket_id text REFERENCES storage.buckets (id),
  name text,
  owner uuid,
  owner_id text,
  metadata jsonb,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

-- Splits a path and returns everything but the file name, so element 1 is the
-- first folder: the team id for vault, the team or user id for avatars.
CREATE OR REPLACE FUNCTION storage.foldername(name text) RETURNS text[]
  LANGUAGE plpgsql
AS $$
DECLARE
  _parts text[];
BEGIN
  SELECT string_to_array(name, '/') INTO _parts;
  RETURN _parts[1:array_length(_parts, 1) - 1];
END
$$;

CREATE OR REPLACE FUNCTION storage.filename(name text) RETURNS text
  LANGUAGE plpgsql
AS $$
DECLARE
  _parts text[];
BEGIN
  SELECT string_to_array(name, '/') INTO _parts;
  RETURN _parts[array_length(_parts, 1)];
END
$$;

-- On Supabase these grants already exist; the policies are what narrow them.
GRANT USAGE ON SCHEMA storage TO anon, authenticated, service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON storage.objects TO anon, authenticated, service_role;
GRANT SELECT ON storage.buckets TO anon, authenticated, service_role;
