-- 00-bootstrap.sql — what `drizzle-kit push` needs and cannot create.
--
-- Run on a fresh Supabase project BEFORE `drizzle-kit push` (schema.ts declares
-- inbox.fts as a stored column computed by generate_inbox_fts, and every RLS
-- policy calls private.get_teams_for_authenticated_user). Idempotent: every
-- statement is CREATE IF NOT EXISTS or CREATE OR REPLACE, so the bootstrap
-- script can run it again at any time.
--
-- Recovered from the Supabase dump that lived at
-- apps/api/supabase/migrations/20240624104607_remote_schema.sql until commit
-- c5ac672f3. Deliberately NOT recovered: handle_new_user,
-- on_auth_user_created, insert_system_categories, webhook(), embed_category
-- and every supabase_functions.http_request trigger — that logic lives in
-- apps/api now and a database copy would double-create teams.
--
-- Also works on the vanilla Postgres from docker-compose.test.yml, where the
-- function bodies cannot be validated yet (auth.uid() and users_on_team do
-- not exist before the push); hence check_function_bodies off.

set check_function_bodies = off;

-- Extensions. Unqualified on purpose: on Supabase an extension enabled from
-- the dashboard lives in the `extensions` schema, which is on the default
-- search_path, and IF NOT EXISTS matches by name whatever the schema. On a
-- vanilla Postgres they land in `public`, which is also on the search_path.
create extension if not exists vector;
create extension if not exists pg_trgm;
-- gen_random_bytes, which the id generators below are built on.
create extension if not exists pgcrypto;
-- unaccent(), which slugify() in 40-functions.sql is built on.
create extension if not exists unaccent;

-- The `private` schema holds helpers that policies call but the API never
-- exposes through PostgREST.
create schema if not exists private;

-- Team membership of the calling user, evaluated inside RLS policies.
-- security definer so the policy can read users_on_team regardless of that
-- table's own policies; search_path pinned so it cannot be hijacked.
create or replace function private.get_teams_for_authenticated_user()
returns setof uuid
language sql
stable
security definer
set search_path = public
as $$
  select team_id
    from users_on_team
   where user_id = auth.uid()
$$;

-- The teams the calling user has been invited to but has not joined yet.
-- What lets an invited user see the team on the invite screen, before there
-- is a users_on_team row for them. Same shape and same reason as above.
create or replace function private.get_invites_for_authenticated_user()
returns setof uuid
language sql
stable
security definer
set search_path = public
as $$
  select team_id
    from user_invites
   where email = auth.jwt() ->> 'email'
$$;

-- Policies run as the request's role, so those roles need to reach the
-- schema and the function. The roles only exist on Supabase.
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    grant usage on schema private to authenticated, anon, service_role;
    grant execute on function private.get_teams_for_authenticated_user()
      to authenticated, anon, service_role;
    grant execute on function private.get_invites_for_authenticated_user()
      to authenticated, anon, service_role;
  end if;
end
$$;

-- inbox.meta -> 'products' is a JSON array of product names; flatten it into
-- one comma-separated string for the full-text column.
create or replace function public.extract_product_names(products_json json)
returns text
language plpgsql
immutable
as $$
begin
  return (
    select string_agg(value, ',')
      from json_array_elements_text(products_json) as arr(value)
  );
end;
$$;

-- The stored value of inbox.fts. Never null, because the column is NOT NULL.
create or replace function public.generate_inbox_fts(
  display_name_text text,
  product_names text
)
returns tsvector
language plpgsql
immutable
as $$
begin
  return to_tsvector(
    'english',
    coalesce(display_name_text, '') || ' ' || coalesce(product_names, '')
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- Column defaults
-- ---------------------------------------------------------------------------
-- Two columns default to a call into these, and both are UNIQUE, so without
-- them a fresh project takes exactly one row each: teams.inbox_id, the address
-- receipts are forwarded to, and user_invites.code, which is what an invite
-- link proves you hold.
--
-- gen_random_bytes is called unqualified on purpose. Supabase keeps pgcrypto
-- in `extensions`, a bare Postgres puts it in `public`, and both are on the
-- default search_path; the dump's `extensions.gen_random_bytes` would only
-- resolve on Supabase.

create or replace function public.nanoid_optimized(
  size integer,
  alphabet text,
  mask integer,
  step integer
)
returns text
language plpgsql
parallel safe
as $$
declare
  idBuilder      text := '';
  counter        int  := 0;
  bytes          bytea;
  alphabetIndex  int;
  alphabetArray  text[];
  alphabetLength int  := 64;
begin
  alphabetArray := regexp_split_to_array(alphabet, '');
  alphabetLength := array_length(alphabetArray, 1);

  loop
    bytes := gen_random_bytes(step);
    for counter in 0..step - 1
      loop
        alphabetIndex := (get_byte(bytes, counter) & mask) + 1;
        if alphabetIndex <= alphabetLength then
          idBuilder := idBuilder || alphabetArray[alphabetIndex];
          if length(idBuilder) = size then
            return idBuilder;
          end if;
        end if;
      end loop;
  end loop;
end
$$;

create or replace function public.nanoid(
  size integer default 21,
  alphabet text default '_-0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ'::text,
  additionalbytesfactor double precision default 1.6
)
returns text
language plpgsql
parallel safe
as $$
declare
  alphabetArray  text[];
  alphabetLength int := 64;
  mask           int := 63;
  step           int := 34;
begin
  if size is null or size < 1 then
    raise exception 'The size must be defined and greater than 0!';
  end if;

  if alphabet is null or length(alphabet) = 0 or length(alphabet) > 255 then
    raise exception 'The alphabet can''t be undefined, zero or bigger than 255 symbols!';
  end if;

  if additionalBytesFactor is null or additionalBytesFactor < 1 then
    raise exception 'The additional bytes factor can''t be less than 1!';
  end if;

  alphabetArray := regexp_split_to_array(alphabet, '');
  alphabetLength := array_length(alphabetArray, 1);
  mask := (2 << cast(floor(log(alphabetLength - 1) / log(2)) as int)) - 1;
  step := cast(ceil(additionalBytesFactor * mask * size / alphabetLength) as int);

  if step > 1024 then
    step := 1024;
  end if;

  return nanoid_optimized(size, alphabet, mask, step);
end
$$;

-- The inbox address a team forwards receipts to.
create or replace function public.generate_inbox(size integer)
returns text
language plpgsql
as $$
declare
  characters text := 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  bytes bytea := gen_random_bytes(size);
  l int := length(characters);
  i int := 0;
  output text := '';
begin
  while i < size loop
    output := output || substr(characters, get_byte(bytes, i) % l + 1, 1);
    i := i + 1;
  end loop;
  return lower(output);
end;
$$;
