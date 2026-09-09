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
bun run jobs:dashboard   # trigger.dev dev, against packages/jobs/.env
```
