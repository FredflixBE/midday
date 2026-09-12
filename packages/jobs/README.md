# Jobs

Every background job in this fork runs here, on Trigger.dev. Tasks live under
`src/tasks`, which is the only directory `trigger.config.ts` scans.

## Schedules

The free plan allows **10 schedules**. This deployment uses seven: five are
declared on the task itself, and two are created at runtime, one per entity.

| Schedule | Cron (UTC) | Off switch |
| --- | --- | --- |
| `invoice-recurring-scheduler` | `0 * * * *` | — |
| `invoice-upcoming-notification` | `30 * * * *` | — |
| `no-match-scheduler` | `0 2 * * *` | `NO_MATCH_SCHEDULER_ENABLED` |
| `rates-scheduler` | `0 0,12 * * *` | `RATES_SCHEDULER_ENABLED` |
| `invoice-scheduler` | `0 0,12 * * *` | `INVOICE_SCHEDULER_ENABLED` |
| `bank-sync-scheduler` | one per team, spread by team id | `BANK_SYNC_SCHEDULER_ENABLED` |
| `inbox-sync-scheduler` | one per inbox account, every 6h | — |

A schedule counts against the limit even when the run exits immediately on its
flag, so a flag is not a way to free a slot — only removing the cron is. Three
jobs lost theirs for that reason (FF-1521); they are under **Started by hand**
below.

The remaining headroom is what the Yuki integration spends, and it gets one
schedule however many syncs are added to it.

The two runtime schedules go with what they belong to. Disconnecting an inbox
account deletes its schedule; deleting a team's last bank connection deletes the
team's bank schedule; deleting a team deletes both kinds (`delete-team`, which
also empties the team's storage folders). Anything those miss removes itself:
an inbox schedule whose account is gone, or a bank schedule whose team has no
connections left, deletes its own schedule the next time it fires.

## Started by hand

These are ordinary tasks on no cron. The first two have a button on **Settings
→ Admin**, which triggers them through the API and shows what the run did; the
list behind that page is `src/maintenance.ts`, and adding a third button is one
entry in it.

| Task | Why it is not on a cron | Off switch |
| --- | --- | --- |
| `sync-institutions` | the list of banks barely changes, and this fork serves one business | `SYNC_INSTITUTIONS_ENABLED` |
| `ensure-bank-schedulers` | a safety net for a deployment with many teams; connecting a bank already creates its schedule, and deleting one removes it | `BANK_SYNC_SCHEDULER_ENABLED` |
| `activity-notification-flush` | it flushes batched Slack notifications, and Slack is on hold in this fork — about 43,000 empty runs a month | — |

`activity-notification-flush` has no button because there is nothing for it to
flush yet. Putting its minute back when Slack comes off hold is a one-line
change, and one schedule.

Insight generation is ported and can be triggered by hand too, but is
deliberately registered on no schedule at all.

**Removing a cron does not remove the schedule that is already registered.** A
schedule that disappears from the code stays in the Trigger.dev dashboard, and
keeps counting against the ten, until it is deleted there by hand.

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
| `small-1x` | 410 MiB | one file in memory at a time; HEIC photos up to 14 MP |
| `small-2x` | 819 MiB | multi-pass OCR, and HEIC photos up to 32 MP; the transaction export |
| `medium-1x` | 1638 MiB | the full team export |

`trigger dev` applies the same limit as the cloud, so an undersized preset
fails locally exactly as it would in production — as
`TASK_PROCESS_OOM_KILLED`, with the V8 heap-limit trace in the run's logs.

That holds for the heap only. Memory outside it — WebAssembly, `Buffer`s,
sharp's native allocations — counts against a deployed machine's whole memory
and against nothing locally, so `trigger dev` will not catch an overrun there.
HEIC conversion is almost entirely off-heap (6 MiB of heap at any size), which
is why its ceilings in `utils/image-processing.ts` are measured against the
machine's memory rather than the heap column above.

One thing that makes this easy to misread: `experimental_processKeepAlive` in
`trigger.config.ts` reuses a worker process across runs, so a run starts
holding whatever the previous one retained. A task sized too tightly therefore
tends to succeed the first time and die on the second, quickly, rather than
degrading gradually.
