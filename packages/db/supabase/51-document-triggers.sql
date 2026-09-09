-- 51-document-triggers.sql — fire 50-documents.sql on a vault upload.
--
-- Separate from 50-documents.sql for the same reason 11-storage-policies.sql
-- is separate from 10-storage.sql: storage.objects belongs to Supabase
-- (supabase_storage_admin owns it), and CREATE TRIGGER needs the TRIGGER
-- privilege on the table. Creating a *policy* on storage.objects is permitted
-- for the pooler role, and a trigger on auth.users was too, but a trigger on
-- storage.objects has not been proven on a real project. If it is refused,
-- db:bootstrap reports it and carries on rather than failing, and the file can
-- be pasted into the Supabase SQL editor.
--
-- Idempotent: both triggers are dropped and recreated.
--
-- One deliberate departure from the hosted project: the WHEN clause. The
-- recovered function does not look at the bucket, and the historical trigger's
-- own definition was not in the dump — storage is Supabase's schema, so it was
-- never dumped. Without the clause an avatar upload would create a documents
-- row too, because avatars paths also begin with an id, and it would show up
-- in the vault as a file nobody put there.

drop trigger if exists insert_into_documents on storage.objects;
create trigger insert_into_documents
  after insert on storage.objects
  for each row
  when (new.bucket_id = 'vault')
  execute function public.insert_into_documents();

drop trigger if exists delete_from_documents on storage.objects;
create trigger delete_from_documents
  after delete on storage.objects
  for each row
  when (old.bucket_id = 'vault')
  execute function public.delete_from_documents();
