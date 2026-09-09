# Supabase SQL

What `drizzle-kit push` cannot create, and what it creates wrongly.

| file | what it is |
| --- | --- |
| `00-bootstrap.sql` | Extensions, the `private` schema, and the functions the schema *calls* — before the tables that call them exist. |
| `10-storage.sql` | The `vault`, `avatars` and `apps` buckets. |
| `11-storage-policies.sql` | Who may reach into them. Separate because `storage.objects` belongs to Supabase. |
| `20-realtime.sql` | Publication membership, and the `activities` read policy. |
| `30-auth-user.sql` | The trigger that gives a new sign-in its `public.users` row. |
| `40-functions.sql` | The functions the application calls at runtime. |
| `50-documents.sql` | The functions that keep `documents` in step with the `vault` bucket. |
| `51-document-triggers.sql` | The triggers that fire them. Separate for the same reason as `11-`. |

All are idempotent, and `bun run db:bootstrap` applies them in order with
`drizzle-kit push` and the RLS policies in between. The policy step is not
optional: `drizzle-kit push` creates every policy without its `USING`
expression, and a policy without one grants nothing, so a project that skipped
it would be closed to the browser while looking fine from the API. See
[SELF_HOSTING.md](../../../SELF_HOSTING.md#building-the-database).

## Running it against the Frankfurt project

Once, on the empty project, from the repository root:

```bash
DATABASE_SESSION_POOLER='<Supabase > Project Settings > Database > session pooler>' \
  bun run db:bootstrap
```

It prints a pass/fail line per check and exits non-zero if any failed. Paste
that output into FF-1395.

The connection string carries the database password: the script never prints
it, and neither should the paste.

`bun run` loads `packages/db/.env`, which already sets
`DATABASE_SESSION_POOLER` to the Frankfurt project, so the command targets it
even if you pass nothing. Before it changes anything the script prints the
database and host it is about to build — read that line first.

### If the storage policies or the document triggers are skipped

`storage.objects` belongs to Supabase (`supabase_storage_admin` owns it), so
what may be done to it is narrower than for our own tables. Creating policies
on it is allowed; owning operations are not. If a project ever refuses the
file anyway, the script says so and carries on rather than failing:

```
5. storage policies
  skipped 11-storage-policies.sql — permission denied for schema storage
```

`51-document-triggers.sql` can be refused the same way, and matters as much:
without it a vault upload lands in storage and never appears in the vault,
because the vault lists `documents` rows rather than storage objects. Creating
a *policy* on `storage.objects` is permitted for the pooler role and a trigger
on `auth.users` was too, but a trigger on `storage.objects` has not been proven
on a real project — the bootstrap says which of the two it skipped.

Paste that file into the **Supabase SQL editor** and run it, then run
`db:bootstrap` again. Note that a file is applied as one transaction, so one
refused statement takes the whole file with it — the message names the reason,
and it is the statement, not the file, that needs looking at.

### If it refuses to start

```
public already has N tables.
```

That is the guard, not a bug. `db:bootstrap` pushes with `--force`, which drops
whatever does not match the schema, so it will not touch a project that already
has one.

If a previous run stopped part-way, that is also what you will see, and
continuing is what you want:

```bash
ALLOW_NON_EMPTY=true bun run db:bootstrap
```

Safe while the project has no data in it: every step is idempotent, and the
push has nothing to drop from a schema that already matches.

### After it passes

Sign in through the dashboard and check the three things the SQL is for, which
no script can check for you because they need a browser and a session:

1. **Login.** Google sign-in reaches onboarding rather than an error. The
   `users` row it creates proves the `auth.users` foreign key and the id
   generators work.
2. **Upload.** Drop a file into the vault. It lands under `<team id>/…`, which
   is the storage policy allowing it — and the file appears without a reload,
   which is the realtime publication.
3. **Notifications.** They arrive without a refresh: `activities` published, and
   its policy letting you read your own.

If uploads work but nothing appears until you reload, the publication is the
thing to look at, not the upload.
