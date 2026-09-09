# Migrations

`0000_base_schema.sql` is the whole schema as one file, generated from
`src/schema.ts`. Everything before it is in `archive/`.

## The two ways a database gets built

| | for | what it does |
| --- | --- | --- |
| `bun run db:bootstrap` | an empty project | Builds from `schema.ts` with `drizzle-kit push`, plus the Supabase SQL that push cannot create. Then records this journal as applied. |
| `bun run db:migrate` | a project that already exists | Applies whatever in this journal the database has not recorded yet. |

The bootstrap ends up at the state the journal describes without running any
of it, so it writes the journal into `drizzle.__drizzle_migrations` itself.
Without that, the first `db:migrate` on a fresh project would try to
`CREATE TABLE` over tables the push had just made.

## A project that was built before any of this existed

`db:bootstrap` records the journal for a project it builds itself. A project
built by an earlier bootstrap has the schema but an empty
`drizzle.__drizzle_migrations`, so the first `db:migrate` would try to
`CREATE TABLE` over all of it and fail.

`bun run db:stamp` is the one-time fix. Run it with no arguments first — it
prints the journal and what is already recorded, and changes nothing:

```bash
DATABASE_SESSION_POOLER='<session pooler URL>' bun run db:stamp
DATABASE_SESSION_POOLER='<session pooler URL>' bun run db:stamp --through 0000_base_schema
```

**Naming the right tag is the whole decision.** Stamping past what the database
actually contains skips a migration it needs, silently and permanently, which
is why there is no default. A project built by the FF-1369 bootstrap was pushed
from the `schema.ts` of that moment: that is the base migration and nothing
after it. Everything later stays pending and `db:migrate` applies it.

## Changing the schema

1. Edit `src/schema.ts`.
2. `bun run db:generate` — writes the next migration and updates the snapshot.
3. Read the SQL it produced. `generate` diffs against `meta/*_snapshot.json`,
   so it emits what changed since the last one and nothing else.
4. Commit the `.sql`, the snapshot and the journal together. A snapshot
   committed without its migration is how a repair becomes invisible: the next
   `generate` diffs against it and emits nothing.
5. `bun run db:migrate` applies it.

`meta/` is excluded from biome in the root `biome.json`. drizzle-kit writes
those files and would keep rewriting them, so formatting them here would leave
a lint failure behind every `db:generate` — a trap rather than a standard.

## Why the base migration is generated rather than assembled

The 39 files in `archive/` are the history: hand-written migrations that were
never in the journal, so `drizzle-kit migrate` neither applied them nor knew
about them. They also predate several repairs that were made directly to the
snapshot — the `auth.users` foreign key, `generate_inbox(10)` and `nanoid(24)`
as calls rather than string literals, six composite index operator classes, and
the restored `USING` expressions on the tables realtime reads.

Generating `0000` from the current `schema.ts` is what makes it carry those. A
base assembled from the archived files would not have them, and nothing would
have said so.

It also carries more than `push` manages: every policy **with** its `USING`
expression, and `ENABLE ROW LEVEL SECURITY` on every table that wants it.
`drizzle-kit push` drops both (see `src/scripts/policies.ts`), which is why the
bootstrap has a separate policy step and `db:migrate` does not need one.
