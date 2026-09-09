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

## Changing the schema

1. Edit `src/schema.ts`.
2. `bun run db:generate` — writes the next migration and updates the snapshot.
3. Read the SQL it produced. `generate` diffs against `meta/*_snapshot.json`,
   so it emits what changed since the last one and nothing else.
4. Commit the `.sql`, the snapshot and the journal together. A snapshot
   committed without its migration is how a repair becomes invisible: the next
   `generate` diffs against it and emits nothing.
5. `bun run db:migrate` applies it.

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
