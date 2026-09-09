-- 11-storage-policies.sql — who may reach into each bucket.
--
-- SEPARATE FROM 10-storage.sql BECAUSE OF WHO MAY RUN IT. On Supabase,
-- storage.objects is owned by supabase_storage_admin; Postgres requires table
-- ownership to CREATE POLICY, and the `postgres` role the session pooler
-- gives you is not a member of that role. So `bun run db:bootstrap` cannot
-- apply this file and will tell you so — paste it into the Supabase SQL
-- editor instead, or use Storage > Policies in the dashboard.
--
-- RLS is already enabled on storage.objects by Supabase, so there is no
-- ALTER TABLE here; that too would need ownership.
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
-- Folder placeholders
-- ---------------------------------------------------------------------------
-- Recovered from line 8 of the dump named above, so a fresh project matches
-- what the old one had. Note that it is not wired to anything: no dump in the
-- history creates a trigger that calls it, and the constant naming the file it
-- looks for (EMPTY_FOLDER_PLACEHOLDER_FILE_NAME, packages/supabase) is
-- exported but never imported. It is here to be faithful, not because
-- something calls it — see the note on FF-1393.
create or replace function storage.handle_empty_folder_placeholder()
returns trigger
language plpgsql
as $$
declare
  name_tokens text[];
  modified_name text;
begin
  name_tokens := string_to_array(new.name, '/');

  if name_tokens[array_length(name_tokens, 1)] = '.emptyFolderPlaceholder' then
    name_tokens[array_length(name_tokens, 1)] := '.folderPlaceholder';
    modified_name := array_to_string(name_tokens, '/');

    insert into storage.objects (bucket_id, name, owner, owner_id)
    values (new.bucket_id, modified_name, new.owner, new.owner_id);
  end if;

  return new;
end;
$$;
