-- 10-storage.sql — the three buckets.
--
-- The policies that go with them are in 11-storage-policies.sql, which needs a
-- connection this one does not: on Supabase, storage.objects is owned by
-- supabase_storage_admin, and Postgres requires table ownership to create a
-- policy. The pooler role can write storage.buckets but not policy
-- storage.objects, so the two are applied separately.
--
-- Idempotent: the buckets upsert.

-- ---------------------------------------------------------------------------
-- Buckets
-- ---------------------------------------------------------------------------
-- `vault` is private: everything in it is a team's own documents, receipts and
-- invoices, reached through signed URLs or the secret key. `avatars` and
-- `apps` are public because the dashboard renders them with getPublicUrl(),
-- which issues an unsigned URL.
--
-- The size limits sit above what the dashboard itself accepts (3-5 MB per
-- upload, 15 MB for the HEIC conversion path) so that the bucket is never the
-- thing that rejects a file the app was willing to take.
--
-- allowed_mime_types is deliberately left null. The app already decides what
-- it accepts, in @midday/documents' allowedMimeTypes and each upload zone; a
-- second list here would be a second thing to keep in step, and the failure
-- mode is a silent rejection at upload time.
insert into storage.buckets (id, name, public, file_size_limit)
values
  ('vault',   'vault',   false, 52428800),   -- 50 MB
  ('avatars', 'avatars', true,   5242880),   --  5 MB
  ('apps',    'apps',    true,   5242880)    --  5 MB
on conflict (id) do update
  set public = excluded.public,
      file_size_limit = excluded.file_size_limit;
