-- 11-storage-policies.sql — who may reach into each bucket.
--
-- Separate from 10-storage.sql because storage.objects belongs to Supabase
-- (supabase_storage_admin owns it), so what may be done to it is narrower than
-- what may be done to a bucket row. Creating policies on it is allowed; owning
-- operations are not, which is why there is no ALTER TABLE ... ENABLE ROW
-- LEVEL SECURITY here — Supabase has it on already, and the statement would
-- need the owner.
--
-- If a project ever does refuse this file, db:bootstrap reports it and carries
-- on rather than failing, and it can be pasted into the Supabase SQL editor.
--
-- Idempotent: every policy is dropped and recreated.
--
-- Recovered from the Supabase dump that lived at
-- apps/api/supabase/migrations/20240917165404_remote_schema.sql until commit
-- c5ac672f3 (lines 88-197). Two deliberate departures from that text:
--
--  * Team membership is tested with private.get_teams_for_authenticated_user()
--    rather than an inline `EXISTS (SELECT 1 FROM users_on_team ...)`. The
--    inline form reads users_on_team as the caller, so it is subject to that
--    table's own RLS; the function is SECURITY DEFINER and is what every
--    policy in schema.ts already uses. Same rule, one way of spelling it.
--  * Policies are named for what they allow, not "Give members access to team
--    folder 1uo56a_0" as the dashboard generated them.

-- ---------------------------------------------------------------------------
-- vault — the team's own files
-- ---------------------------------------------------------------------------
-- Every vault path starts with the team id: [teamId, "transactions", id, file]
-- from the dashboard's upload zones, [teamId, "inbox", ...] from inbox uploads.
-- storage.foldername(name) splits the path, so element 1 is that team id.
drop policy if exists "Vault files are readable by the team that owns them" on storage.objects;
create policy "Vault files are readable by the team that owns them"
  on storage.objects for select to authenticated
  using (
    bucket_id = 'vault'
    and (storage.foldername(name))[1] in (
      select private.get_teams_for_authenticated_user()::text
    )
  );

drop policy if exists "Vault files can be uploaded by the team that owns them" on storage.objects;
create policy "Vault files can be uploaded by the team that owns them"
  on storage.objects for insert to authenticated
  with check (
    bucket_id = 'vault'
    and (storage.foldername(name))[1] in (
      select private.get_teams_for_authenticated_user()::text
    )
  );

drop policy if exists "Vault files can be updated by the team that owns them" on storage.objects;
create policy "Vault files can be updated by the team that owns them"
  on storage.objects for update to authenticated
  using (
    bucket_id = 'vault'
    and (storage.foldername(name))[1] in (
      select private.get_teams_for_authenticated_user()::text
    )
  );

drop policy if exists "Vault files can be deleted by the team that owns them" on storage.objects;
create policy "Vault files can be deleted by the team that owns them"
  on storage.objects for delete to authenticated
  using (
    bucket_id = 'vault'
    and (storage.foldername(name))[1] in (
      select private.get_teams_for_authenticated_user()::text
    )
  );

-- ---------------------------------------------------------------------------
-- avatars — team logos and user avatars
-- ---------------------------------------------------------------------------
-- Two shapes of path live here, which is why the historical database had two
-- families of policy: [teamId, file] and [teamId, "invoice", file] for a team
-- logo, [userId, file] for a user's own avatar. A writer must own one or the
-- other.
--
-- Reads are restricted to the same owners, as the historical policy had them.
-- Rendering does not go through here: getPublicUrl() builds an unsigned URL
-- that Supabase serves without consulting these policies, and nothing in the
-- app lists this bucket. So this costs nothing and keeps one signed-in user
-- from enumerating every team's files.
drop policy if exists "Avatars are readable by anyone" on storage.objects;
drop policy if exists "Avatars are readable in a team or own folder" on storage.objects;
create policy "Avatars are readable in a team or own folder"
  on storage.objects for select to authenticated
  using (
    bucket_id = 'avatars'
    and (
      (storage.foldername(name))[1] in (
        select private.get_teams_for_authenticated_user()::text
      )
      or (storage.foldername(name))[1] = auth.uid()::text
    )
  );

drop policy if exists "Avatars can be uploaded to a team or own folder" on storage.objects;
create policy "Avatars can be uploaded to a team or own folder"
  on storage.objects for insert to authenticated
  with check (
    bucket_id = 'avatars'
    and (
      (storage.foldername(name))[1] in (
        select private.get_teams_for_authenticated_user()::text
      )
      or (storage.foldername(name))[1] = auth.uid()::text
    )
  );

drop policy if exists "Avatars can be updated in a team or own folder" on storage.objects;
create policy "Avatars can be updated in a team or own folder"
  on storage.objects for update to authenticated
  using (
    bucket_id = 'avatars'
    and (
      (storage.foldername(name))[1] in (
        select private.get_teams_for_authenticated_user()::text
      )
      or (storage.foldername(name))[1] = auth.uid()::text
    )
  );

drop policy if exists "Avatars can be deleted from a team or own folder" on storage.objects;
create policy "Avatars can be deleted from a team or own folder"
  on storage.objects for delete to authenticated
  using (
    bucket_id = 'avatars'
    and (
      (storage.foldername(name))[1] in (
        select private.get_teams_for_authenticated_user()::text
      )
      or (storage.foldername(name))[1] = auth.uid()::text
    )
  );

-- ---------------------------------------------------------------------------
-- apps — OAuth application logos and screenshots
-- ---------------------------------------------------------------------------
-- No historical policy existed for this bucket; it was created and left open
-- from the dashboard. Its paths carry no owner to check against — they are
-- ["logos", <nanoid>.png] and ["screenshots", <nanoid>.png] — so a
-- team-folder rule cannot be expressed here without changing those paths.
--
-- The rule is therefore: anyone may read (the bucket is public and these
-- images are rendered on the OAuth consent screen), and only a signed-in user
-- may write, and only under the two folders the app actually uses. That last
-- clause is what stops the bucket from being a general-purpose drop box for
-- any authenticated user.
drop policy if exists "App images are readable by anyone" on storage.objects;
create policy "App images are readable by anyone"
  on storage.objects for select to public
  using (bucket_id = 'apps');

drop policy if exists "App images can be uploaded by signed-in users" on storage.objects;
create policy "App images can be uploaded by signed-in users"
  on storage.objects for insert to authenticated
  with check (
    bucket_id = 'apps'
    and (storage.foldername(name))[1] in ('logos', 'screenshots')
  );

drop policy if exists "App images can be updated by signed-in users" on storage.objects;
create policy "App images can be updated by signed-in users"
  on storage.objects for update to authenticated
  using (
    bucket_id = 'apps'
    and (storage.foldername(name))[1] in ('logos', 'screenshots')
  );

drop policy if exists "App images can be deleted by signed-in users" on storage.objects;
create policy "App images can be deleted by signed-in users"
  on storage.objects for delete to authenticated
  using (
    bucket_id = 'apps'
    and (storage.foldername(name))[1] in ('logos', 'screenshots')
  );

-- ---------------------------------------------------------------------------
-- Folder placeholders — deliberately not recreated
-- ---------------------------------------------------------------------------
-- The old database had storage.handle_empty_folder_placeholder(), recovered
-- from line 8 of the dump named above. It is not here, for two reasons that
-- point the same way.
--
-- It cannot be: creating a function in the storage schema needs CREATE on that
-- schema, which the pooler role does not have — and because a file is applied
-- as one transaction, that single statement failing took all twelve policies
-- above down with it.
--
-- And it need not be: nothing calls it. No dump in the history creates a
-- trigger for it, and EMPTY_FOLDER_PLACEHOLDER_FILE_NAME in packages/supabase
-- is exported and never imported. Reproducing a function that nothing invokes,
-- in a schema we cannot write to, is fidelity for its own sake. See FF-1393.
