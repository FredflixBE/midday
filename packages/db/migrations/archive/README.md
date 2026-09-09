# Archived migrations

The 39 hand-written migrations that were in `migrations/` before
`0000_base_schema.sql` existed.

They were never listed in `meta/_journal.json`, so `drizzle-kit migrate` never
applied them and never knew about them — the journal named a single migration,
`0000_silly_sage`, whose file did not exist. That is what made `db:migrate`
exit 1 against every database while changing nothing (FF-1430).

They are kept, and kept out of the journal, because:

- The base migration contains everything they did. It is generated from
  `src/schema.ts`, which is the accumulated result of all of them.
- Left in `migrations/` they read as pending steps, which is what made this
  confusing in the first place. drizzle-kit does not descend into
  subdirectories, so here they are inert.
- They are the readable record of what upstream changed and when, without
  going through git.

Nothing runs them. Do not add to this directory — new work goes through
`bun run db:generate`.
