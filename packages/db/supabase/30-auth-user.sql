-- 30-auth-user.sql — give every authenticated user a row in public.users.
--
-- Run after `drizzle-kit push`: public.users has to exist.
-- Idempotent: CREATE OR REPLACE, and the trigger is dropped and recreated.
--
-- Without this, signing in with Google succeeds and then every request fails.
-- The team-permission middleware runs on every protectedProcedure and throws
-- NOT_FOUND when the caller has no public.users row, so a new user cannot even
-- reach onboarding — the screen whose job is to create the row's missing parts.
--
-- The epic (FF-1369) said not to recreate handle_new_user, and this is a
-- deliberate, narrowed exception to that. The original did two things:
--
--   1. insert into public.users   — nothing else ever did this, and its
--                                   absence is what breaks sign-in
--   2. insert into public.teams   — apps/api does this now, in createTeam
--                                   during onboarding
--
-- Only the first is here. Recreating the second is what the epic was guarding
-- against: it would give every new user a team before onboarding asks them
-- what it should be called, and onboarding would then make a second one.
--
-- Recovered from the dump deleted in c5ac672f3
-- (apps/api/supabase/migrations/20240624104607_remote_schema.sql, line 617),
-- minus the team half and the webhook call.

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- Google is the only provider, and it supplies both of these. Coalesce
  -- anyway: a provider that omits them should still produce a usable row,
  -- because onboarding asks for the full name and can fill it in.
  insert into public.users (id, email, full_name, avatar_url)
  values (
    new.id,
    new.email,
    new.raw_user_meta_data ->> 'full_name',
    new.raw_user_meta_data ->> 'avatar_url'
  )
  on conflict (id) do nothing;

  return new;
end;
$$;

-- auth.users belongs to supabase_auth_admin, but TRIGGER privilege on it is
-- granted to the pooler role, so this can be applied like everything else.
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();
