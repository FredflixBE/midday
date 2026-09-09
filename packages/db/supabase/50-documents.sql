-- 50-documents.sql — keep public.documents in step with the vault bucket.
--
-- Run after `drizzle-kit push`: public.documents has to exist. Idempotent:
-- both functions are CREATE OR REPLACE.
--
-- Nothing in this repository ever inserts a documents row.
-- packages/db/src/queries/documents.ts only selects, updates and deletes, and
-- the dashboard uploads straight to Supabase Storage over tus — apps/api never
-- sees the file, only the processDocument call that follows it. The rows came
-- from a trigger on storage.objects in Midday's hosted project, which FF-1369
-- never recreated. Without it a file lands in the bucket and never appears in
-- the vault, because the vault lists documents rows.
--
-- The triggers themselves are in 51-document-triggers.sql, because
-- storage.objects belongs to Supabase and creating a trigger on it may be
-- refused; these functions are ours and always apply.
--
-- Recovered from the dump deleted in c5ac672f3
-- (apps/api/supabase/migrations/20240917165251_remote_schema.sql).

-- Deliberately SECURITY INVOKER, as the original was: the insert then goes
-- through documents' own RLS as the uploading user. That works because
-- team_id below is path_tokens[1], and the vault storage policy has already
-- established that element 1 is a team the caller belongs to
-- (11-storage-policies.sql). If a legitimate upload ever fails with a
-- documents RLS error, that pairing is what to look at.
create or replace function public.insert_into_documents()
returns trigger
language plpgsql
as $$
declare
  modified_name text;
  team_id uuid;
  parent_id text;
begin
  -- Every vault path starts with the team id: [teamId, file] from the vault
  -- upload zone, [teamId, "inbox", ...] and [teamId, "transactions", ...] from
  -- the others.
  team_id := new.path_tokens[1];

  if array_length(new.path_tokens, 1) > 1 then
    if new.path_tokens[array_length(new.path_tokens, 1)] = '.emptyFolderPlaceholder' then
      parent_id := new.path_tokens[array_length(new.path_tokens, 1) - 2];
    else
      parent_id := new.path_tokens[array_length(new.path_tokens, 1) - 1];
    end if;
  else
    parent_id := null;
  end if;

  if new.name not like '%.emptyFolderPlaceholder' then
    insert into public.documents (
      id, name, created_at, metadata, path_tokens, team_id, parent_id,
      object_id, owner_id
    )
    values (
      new.id, new.name, new.created_at, new.metadata, new.path_tokens, team_id,
      parent_id, new.id, new.owner_id::uuid
    )
    -- The dashboard uploads with x-upsert, so the same path can arrive twice.
    -- The original had no guard and would have raised on the second one.
    on conflict (id) do nothing;
  end if;

  -- A file nested below the team folder gets a placeholder row for the folder
  -- it sits in, which is what makes the folder itself appear in the vault.
  -- The four reserved prefixes are the application's own storage areas, not
  -- folders anyone browses.
  if array_length(new.path_tokens, 1) > 2
     and parent_id not in ('inbox', 'transactions', 'exports', 'imports') then
    modified_name := regexp_replace(new.name, '([^/]+)$', '.folderPlaceholder');

    if not exists (select 1 from public.documents where name = modified_name) then
      insert into public.documents (name, team_id, path_tokens, parent_id, object_id)
      values (
        modified_name, team_id, string_to_array(modified_name, '/'), parent_id,
        new.id
      );
    end if;
  end if;

  return new;
end;
$$;

create or replace function public.delete_from_documents()
returns trigger
language plpgsql
as $$
begin
  delete from public.documents where object_id = old.id;
  return old;
end;
$$;
