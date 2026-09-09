# Supabase SQL

What `drizzle-kit push` cannot create, and what it creates wrongly.

| file | what it is |
| --- | --- |
| `00-bootstrap.sql` | Extensions, the `private` schema, and the functions the schema *calls* — before the tables that call them exist. |
| `10-storage.sql` | The `vault`, `avatars` and `apps` buckets. |
| `11-storage-policies.sql` | Who may reach into them. **Needs a privileged connection** — see below. |
| `20-realtime.sql` | Publication membership, and the `activities` read policy. |

All are idempotent, and `bun run db:bootstrap` applies them in order with
`drizzle-kit push` and the RLS policies in between. See
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

### The storage policies need the dashboard

On Supabase, `storage.objects` is owned by `supabase_storage_admin`, and
Postgres requires a table's owner to create a policy on it. The `postgres`
role behind the session pooler is not a member of that role, so
`db:bootstrap` cannot apply `11-storage-policies.sql`. It says so and carries
on rather than failing:

```
5. storage policies
  skipped 11-storage-policies.sql — must be owner of table objects
```

Paste that file into the **Supabase SQL editor** and run it. If that also
refuses, use **Storage > Policies** in the dashboard, which always has the
rights. Then run `db:bootstrap` again — everything is idempotent — and the
`every bucket has a policy for all four commands` check will pass.

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
