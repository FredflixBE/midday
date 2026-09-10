# Jobs

Every background job in this fork runs here, on Trigger.dev. Tasks live under
`src/tasks`, which is the only directory `trigger.config.ts` scans.

## Schedules

The free plan allows **10 schedules**, and this deployment uses all 10 for a
single user. Eight are declared on the task itself; two are created at runtime,
one per entity.

| Schedule | Cron (UTC) | Off switch |
| --- | --- | --- |
| `activity-notification-flush` | `*/1 * * * *` | — |
| `invoice-recurring-scheduler` | `0 * * * *` | — |
| `invoice-upcoming-notification` | `30 * * * *` | — |
| `no-match-scheduler` | `0 2 * * *` | `NO_MATCH_SCHEDULER_ENABLED` |
| `ensure-bank-schedulers` | `0 3 * * *` | `BANK_SYNC_SCHEDULER_ENABLED` |
| `sync-institutions` | `0 3 * * *` | `SYNC_INSTITUTIONS_ENABLED` |
| `rates-scheduler` | `0 0,12 * * *` | `RATES_SCHEDULER_ENABLED` |
| `invoice-scheduler` | `0 0,12 * * *` | `INVOICE_SCHEDULER_ENABLED` |
| `bank-sync-scheduler` | one per team, spread by team id | `BANK_SYNC_SCHEDULER_ENABLED` |
| `inbox-sync-scheduler` | one per inbox account, every 6h | — |

**There is no headroom.** A second inbox account or a second team with a bank
connection needs an eleventh schedule, which the free plan will refuse. If you
hit that, `activity-notification-flush` is the first to drop: it only flushes
batched Slack notifications, and Slack is on hold in this fork.

Insight generation is ported and can be triggered by hand, but is deliberately
registered on no schedule at all.

The off switches read through `isFlagEnabled()` in `@midday/utils/flags`: unset
means **on**, and only `false`, `0`, `no` or `off` turn a job off. The one
exception is `INVOICE_JOBS_DRY_RUN`, which is off unless set — it makes the two
invoice schedules log what they would generate and send nothing, so defaulting
it on would quietly stop invoicing. The schedule
still fires when a flag is off — the task returns immediately instead. That
costs a negligible amount of compute and keeps the schedule in place, so
turning a job back on is an environment change rather than a deploy.

## Local development

```bash
bun run jobs:dev            # or: npx trigger.dev@latest dev
```

The project is named in `trigger.config.ts`, so nothing has to be exported
first and the plain CLI invocation works too. Everything else the tasks need
comes from `packages/jobs/.env`, which the CLI loads for the run itself.

It registers every task and schedule against the Trigger.dev **dev**
environment and stays attached, running each task locally as it is triggered.
Leave it running while you use the API and dashboard, or nothing that dispatches
a job will get one.

## Machines

Trigger.dev sizes V8's heap from the task's machine preset — `memory * 1024 *
0.8`, in `@trigger.dev/core/v3/machines`. The default preset, `micro`, is
0.25 GB, which leaves a **205 MiB** heap. This bundle's own module graph —
the AI SDKs, the langchain loaders, sharp, unpdf, drizzle — is a large share of
that before a task allocates anything of its own, so any task that holds a file
or a model payload has to say what it needs:

| Preset | Heap | Tasks |
| --- | --- | --- |
| `micro` (default) | 205 MiB | everything that only reads and writes rows |
| `small-1x` | 410 MiB | one file in memory at a time |
| `small-2x` | 819 MiB | multi-pass OCR; the transaction export |
| `medium-1x` | 1638 MiB | the full team export |

`trigger dev` applies the same limit as the cloud, so an undersized preset
fails locally exactly as it would in production — as
`TASK_PROCESS_OOM_KILLED`, with the V8 heap-limit trace in the run's logs.

One thing that makes this easy to misread: `experimental_processKeepAlive` in
`trigger.config.ts` reuses a worker process across runs, so a run starts
holding whatever the previous one retained. A task sized too tightly therefore
tends to succeed the first time and die on the second, quickly, rather than
degrading gradually.

## Deleted documents

Deleting an item from the inbox does not stop the jobs already working on it —
nothing records their run ids, so nothing can cancel them. They discover the
deletion themselves, and treat it as a normal ending: the document tasks stop
early and their runs go green having written nothing.

A vault document has two halves, the file in the bucket and the
`public.documents` row, and triggers on `storage.objects` create and drop them
together (`packages/db/supabase/50-documents.sql`). That pairing is the whole
mechanism: when a job finds the half it needs is gone, it asks about the other
one. Both gone means the item was deleted. The other half still present means
the missing one was never created — an upstream bug, which keeps failing
loudly. `src/utils/document-presence.ts` holds the check, and the two cases
never share a log line, so a green run always says which it was.

`classify-document` and `classify-image` ask before the model runs as well as
after the update, because the deletion usually lands during the model call and
the answer is what saves that work from being thrown away.
