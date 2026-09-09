-- 20-realtime.sql — which tables the dashboard may watch, and who may watch.
--
-- Run after `drizzle-kit push`: every table named here has to exist.
-- Idempotent: publication membership is checked before it is added, and the
-- policy is dropped and recreated.
--
-- A subscription that is not in the supabase_realtime publication does not
-- error. It subscribes, stays quiet forever, and looks like a bug somewhere
-- else entirely — which is why this file exists rather than being left to the
-- dashboard.

-- Supabase creates this publication on a new project; a bare Postgres does
-- not, and the test container is one.
do $$
begin
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    create publication supabase_realtime;
  end if;
end
$$;

-- The five tables apps/dashboard subscribes to, plus insights.
--
-- customers        components/tables/customers/data-table.tsx, customer-details.tsx
-- transactions     components/tables/transactions/data-table.tsx
-- documents        components/tables/vault/data-table.tsx, vault/vault-grid.tsx
-- inbox            components/inbox/inbox-view.tsx, inbox-get-started.tsx,
--                  hooks/use-upload-processing-toast.tsx
-- activities       hooks/use-notifications.ts
--
-- insights has no subscriber today, but migration 0018 put it in the
-- publication deliberately. Those migrations never run on a project built by
-- `drizzle-kit push`, so leaving it out would quietly drop something the repo
-- already decided; it costs one low-volume table's worth of WAL.
--
-- Only INSERT and UPDATE are subscribed, and every filter (team_id, user_id,
-- id) reads a column of the new row, so the default replica identity is
-- enough. A DELETE subscription would need REPLICA IDENTITY FULL to see more
-- than the primary key.
do $$
declare
  t text;
begin
  foreach t in array array['customers', 'transactions', 'documents', 'inbox', 'activities', 'insights']
  loop
    if not exists (
      select 1 from pg_publication_tables
       where pubname = 'supabase_realtime'
         and schemaname = 'public'
         and tablename = t
    ) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end
$$;

-- ---------------------------------------------------------------------------
-- activities
-- ---------------------------------------------------------------------------
-- Realtime delivers a row only to a subscriber allowed to SELECT it, so a
-- table in the publication with RLS enabled and no policy is silent — the same
-- symptom as not being published at all.
--
-- activities had neither RLS nor a policy. A notification belongs to one user
-- (use-notifications.ts subscribes with user_id=eq.<id>), so this mirrors
-- notification_settings: you see your own.
--
-- This is also declared in schema.ts, so the snapshot tells the truth. It is
-- repeated here because `drizzle-kit push` creates policies without their
-- USING expression — see the note in the pull request; a policy with no
-- USING grants nothing, so push alone would leave this table silent.
alter table public.activities enable row level security;

drop policy if exists "Activities can be selected by the user they belong to" on public.activities;
create policy "Activities can be selected by the user they belong to"
  on public.activities for select to public
  using (user_id = auth.uid());
