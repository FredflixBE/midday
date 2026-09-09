# Self-hosting this fork

This repository is a single-user, self-hosted fork of Midday. The multi-tenant
SaaS layer (billing, analytics, US bank providers, multi-region database
routing, messaging bots, Railway deploys) has been removed. What is left runs on
one Postgres, one region, and a handful of external services you own.

## Target stack

| Piece | Runs on | Notes |
| --- | --- | --- |
| Database, auth, storage, realtime | Supabase (Frankfurt) | One project. The API and jobs connect through the session pooler (`DATABASE_URL`). |
| API (`apps/api`) | Dokploy on the VPS, built from `apps/api/Dockerfile` | Port 8080, health `/health`, domain `api.midday.fredflix.be`. |
| Dashboard (`apps/dashboard`) | Dokploy on the VPS, built from `apps/dashboard/Dockerfile` | Port 3000, health `/api/health`, domain `midday.fredflix.be`. `NEXT_PUBLIC_*` values are build arguments. |
| Background jobs (`packages/jobs`) | Trigger.dev (free plan) | Every background job. Deployed by `.github/workflows/trigger-deploy.yml`. Ten schedules, which is the whole free-plan budget — see `packages/jobs/README.md`. |
| Redis | Not deployed | Nothing needs it. The Slack chat bot would (`REDIS_URL`, thread state), and Slack is on hold. |
| Bank data | Enable Banking (required), GoCardless (optional) | Plaid and Teller are gone. Institution logos are served from the provider's own URL; there is no object store. |
| Email | Resend | Transactional email only. |
| Login | Google OAuth through Supabase Auth | Plus an internal Google OAuth client with Gmail scopes for inbox sync. |
| Desktop app (`apps/desktop`) | Built locally on a Mac | No updater. See `apps/desktop/README.md`. |
| CI | GitHub Actions, `ubuntu-latest` | `ci.yml` typechecks, lints and tests; on a pull request it also builds the database from empty in a Postgres service container, both ways; on push to `main` it first applies schema migrations. `trigger-deploy.yml` ships the jobs. Dokploy deploys the API and dashboard on the same push. |

Every Dockerfile uses the repository root as build context; the root
`.dockerignore` keeps the context small. The images work from a plain checkout:
the git SHA stamp that CI writes to `.git-commit-sha` is optional, and a
`GIT_COMMIT_SHA` build argument can replace it.

## Order of the work

The self-hosting work is split into epics. Do them in this order; each one
assumes the previous ones landed.

1. **FF-1367 Repo and CI cleanup.** Strip the SaaS and Railway layer (this
   epic). After it the repo builds and typechecks without Polar, OpenPanel,
   Sentry, Plaid, Teller, Railway, read replicas, or the messaging bots.
2. **FF-1369 Fresh Supabase project.** Create the project in Frankfurt,
   configure auth, then apply the schema once with `bun run db:bootstrap`
   (see [Building the database](#building-the-database)).
3. **FF-1371 Accounts and DNS.** The external services: Google Cloud OAuth
   clients, Enable Banking application, Resend, Trigger.dev, DNS records.
4. **FF-1370 Make the code self-hostable.** Remove every hardcoded `midday.ai`
   dependency and the remaining startup blockers.
5. **FF-1368 One job system.** Move every background job to Trigger.dev and
   delete the BullMQ worker. (Done: there is no `apps/worker`, no
   `packages/job-client` and no Redis.)
6. **FF-1372 Deploy and go-live on Dokploy.** The two Dokploy applications,
   env vars, domains, and the go-live checklist.

## Building the database

A new Supabase project gets its schema from `bun run db:bootstrap`, run once
against an empty project:

```bash
DATABASE_SESSION_POOLER='<session pooler URL>' bun run db:bootstrap
```

It refuses to run if `public` already has tables, because it pushes with
`--force`, which drops whatever does not match the schema. That guard is the
difference between building a project and emptying one; override it with
`ALLOW_NON_EMPTY=true` only when you are sure.

Ten steps, in an order that matters:

| | | |
| --- | --- | --- |
| 1 | `packages/db/supabase/00-bootstrap.sql` | Extensions, the `private` schema, and the functions the schema *calls*: `inbox.fts` is a stored column computed by `generate_inbox_fts`, and `teams.inbox_id` and `user_invites.code` default to `generate_inbox()` and `nanoid()`. These have to exist before the tables that use them. |
| 2 | `drizzle-kit push` | Tables, columns, indexes, enums, from `packages/db/src/schema.ts`. |
| 3 | policies | Row level security, read out of `schema.ts`. Separate because `drizzle-kit push` creates every policy **without** its `USING` expression, and a policy with no `USING` grants nothing. |
| 4 | `packages/db/supabase/10-storage.sql` | The `vault`, `avatars` and `apps` buckets. |
| 5 | `packages/db/supabase/11-storage-policies.sql` | Who may reach into them. Separate because `storage.objects` belongs to Supabase, which narrows what may be done to it. If a project refuses the file, the script reports it and carries on. |
| 6 | `packages/db/supabase/20-realtime.sql` | Publication membership for the tables the dashboard subscribes to. |
| 7 | `packages/db/supabase/30-auth-user.sql` | The trigger that gives a new sign-in its `public.users` row. Without it, signing in succeeds and then every request 404s. |
| 8 | `packages/db/supabase/40-functions.sql` | The functions the application calls at runtime, `global_search` among them. |
| 9 | `packages/db/supabase/50-documents.sql` and `51-document-triggers.sql` | A vault upload becomes a `documents` row, which is what the vault lists. The triggers are on `storage.objects`, so they can be refused like step 5; the script reports it and carries on. |
| 10 | migration journal | Records what the schema already contains in `drizzle.__drizzle_migrations`, so `bun run db:migrate` starts from here rather than replaying the base migration. |

Then it runs nineteen checks and prints a pass/fail line for each. **The checks
are the real result**, because `drizzle-kit push` exits 0 even when statements
inside it failed. A non-zero exit means at least one check failed; nothing is
half-applied that a second run will not fix, since every step is idempotent.

Note that `bun run` loads `packages/db/.env`, which already sets
`DATABASE_SESSION_POOLER` to the Supabase project — so the command above
targets Frankfurt whether or not you pass the variable yourself. The script
prints which database and host it is about to build before it touches
anything; read that line. The helper scripts under `packages/db/src/scripts`
deliberately never fall back to that variable: they only ever reach
`TEST_DATABASE_URL`, defaulting to the test container.

### Keeping it awake

A free Supabase project pauses after 7 days with no API activity, and coming
back is a manual restore. The Trigger.dev schedules do not prevent it — they
reach Postgres through the pooler, which is not the API.

`.github/workflows/supabase-keepalive.yml` makes one authenticated REST call
and one storage call, twice a week, using the two repository secrets below. It
fails loudly rather than quietly, because a keepalive that reports success
while the project is unreachable is worse than none.

GitHub disables a scheduled workflow after 60 days with no commit to the
repository, and emails first. A quiet repository is exactly when this matters,
so if the fork goes dormant for a season, check the Actions tab.

### Keeping it current

`bun run db:migrate` applies pending files from `packages/db/migrations`, and is
what CI runs on push to `main`.

`migrations/0000_base_schema.sql` is the whole schema as one file, generated
from `schema.ts`. The bootstrap records it as applied rather than running it,
because step 2 has already built what it describes. To change the schema: edit
`packages/db/src/schema.ts`, run `bun run db:generate`, read the SQL it wrote,
and commit the `.sql`, the snapshot and the journal together. See
[packages/db/migrations/README.md](packages/db/migrations/README.md).

The 39 hand-written migrations that predate the base migration are in
`packages/db/migrations/archive/`. Nothing runs them; the base migration
contains everything they did.

**Before setting the `DATABASE_SESSION_POOLER` repository secret, stamp the
project once.** The Frankfurt project was built by an earlier bootstrap, so it
has the schema but no record of it, and the first `db:migrate` would try to
create everything again:

```bash
DATABASE_SESSION_POOLER='<session pooler URL>' bun run db:stamp
```

That prints the journal and changes nothing. Re-run it with
`--through <tag>`, naming the last migration the project already contains, and
`db:migrate` picks up from there. See
[packages/db/migrations/README.md](packages/db/migrations/README.md).

## Environment variables

One example file per deployable, containing only variables that still exist:

- `apps/api/.env.example`
- `apps/dashboard/.env.example`
- `packages/jobs/.env.example`

Copy the example to `.env` next to it for local development. In Dokploy, paste
the API values as environment, and split the dashboard file: every
`NEXT_PUBLIC_*` line is a build argument, the rest is environment. In
Trigger.dev, set the jobs values on the project.

### URLs

Every URL this deployment needs comes from four variables, read in one place
(`packages/utils/src/envs.ts`):

| Variable | Meaning |
| --- | --- |
| `DASHBOARD_URL` | Public URL of the dashboard. The dashboard itself sets `NEXT_PUBLIC_URL` to the same value. |
| `API_URL` | Public URL of the API. The dashboard sets `NEXT_PUBLIC_API_URL` to the same value. |
| `EMAIL_ASSETS_URL` | Optional. Where the images in emails are served from; defaults to `DASHBOARD_URL`. |
| `CDN_URL` | Optional. Static asset host; defaults to `DASHBOARD_URL`. |

There is no hosted fallback. With `NODE_ENV=production` and no `DASHBOARD_URL`,
the API fails at startup rather than quietly emailing your customers links to
somebody else's instance. Outside production the local ports (`:3001`, `:3003`)
stand in, so a plain `bun run dev` needs nothing set.

The `midday` CLI is configured separately, with `MIDDAY_API_URL` and
`MIDDAY_DASHBOARD_URL`; it is distributed on its own and has no defaults either.

### Shared secrets

Generate each with `openssl rand -hex 32` unless stated otherwise, and use the
same value everywhere the name appears.

| Variable | Used by | Purpose |
| --- | --- | --- |
| `MIDDAY_ENCRYPTION_KEY` | api, jobs | Encrypts provider tokens at rest. 64 hex characters. |
| `INTERNAL_API_KEY` | api, jobs | Service-to-service calls into the API. |
| `INVOICE_JWT_SECRET` | api, dashboard | Signs public invoice links. |
| `FILE_KEY_SECRET` | api, dashboard | Signs file download keys. |
| `WEBHOOK_SECRET_KEY` | dashboard | Verifies the Supabase registration webhook. |
| `MIDDAY_CACHE_API_SECRET` | dashboard | Protects the cache revalidation route. |
| `NEXT_SERVER_ACTIONS_ENCRYPTION_KEY` | dashboard | `openssl rand -base64 32`. Must be identical across replicas. |
| `INBOX_WEBHOOK_USERNAME` / `INBOX_WEBHOOK_PASSWORD` | api | Basic auth on the inbound inbox email webhook. The route refuses every request without them. |

### API (`apps/api`)

| Variable | Required | Where it comes from |
| --- | --- | --- |
| `NODE_ENV`, `LOG_LEVEL`, `LOG_PRETTY` | yes | `production`, `info`, `false` in Dokploy. |
| `PORT` | no | Defaults to 3000; the Dockerfile sets 8080. |
| `DASHBOARD_URL`, `ALLOWED_API_ORIGINS` | yes | The dashboard's public URL (`https://midday.fredflix.be`). The API throws at startup if `DASHBOARD_URL` is unset in production. |
| `API_URL` | yes | The API's public URL (`https://api.midday.fredflix.be`). OAuth redirect URLs, the OpenAPI document and the MCP metadata are built from it. |
| `EMAIL_ASSETS_URL`, `CDN_URL` | no | Where email images and static assets are served from. Both default to `DASHBOARD_URL`. |
| `SUPABASE_URL`, `SUPABASE_SECRET_KEY` | yes | Supabase project settings > API. |
| `SUPABASE_JWT_SECRET` | no | Legacy HS256 fallback; drop once the legacy JWT secret is revoked. |
| `DATABASE_URL` | yes | Supabase > Database > session pooler, port 5432. |
| `DATABASE_SESSION_POOLER` | yes | Same value; used by drizzle-kit and the CI migrate job (as a repository secret). |
| `DB_POOL_MAX` | no | Pool size outside development (default 10). |
| `ENABLEBANKING_APPLICATION_ID`, `ENABLE_BANKING_KEY_CONTENT`, `ENABLEBANKING_REDIRECT_URL` | yes | Enable Banking control panel; the redirect URL points at the API. The API does not start without these. |
| `GOCARDLESS_SECRET_ID`, `GOCARDLESS_SECRET_KEY` | no | GoCardless Bank Account Data portal. Leave empty to disable the provider. |
| `RESEND_API_KEY`, `RESEND_AUDIENCE_ID` | no / no | Resend; the audience receives new sign-ups. The API boots without a key, and the requests that send email fail with a clear error until one is set. |
| `EMAIL_FROM`, `EMAIL_FROM_NAME` | yes to send / no | The address email is sent from, e.g. `Midday <midday@fredflix.be>`. Its domain must be verified with Resend or every message fails DKIM. Invoices go out under the team's name from this address. |
| `INBOX_FORWARDING_DOMAIN` | no | Domain receipts may be forwarded to, e.g. `inbox.fredflix.be`. Requires an inbound email provider posting to `/webhooks/inbox`. Unset means that route is not mounted and the dashboard hides the address; Gmail sync and manual upload are unaffected. Set `NEXT_PUBLIC_INBOX_FORWARDING_DOMAIN` to the same value for the dashboard. |
| `ALLOWED_ASSET_HOSTS` | no | Extra hostnames the renderer may fetch a logo or avatar from, comma-separated. The Supabase storage host and your own `CDN_URL`, `DASHBOARD_URL` and `API_URL` are always allowed. |
| `OPENAI_API_KEY`, `GOOGLE_GENERATIVE_AI_API_KEY`, `MISTRAL_API_KEY` | yes / yes / no | The assistant, embeddings, and document OCR. |
| `COMPOSIO_API_KEY` | no | AI tool connectors. |
| `PLAIN_API_KEY` | no | Plain support tickets; the API only probes it for health. |
| `GMAIL_CLIENT_ID`, `GMAIL_CLIENT_SECRET`, `GMAIL_REDIRECT_URI` | yes for Gmail inbox | The internal Google OAuth client with Gmail scopes (FF-1407); same values as the dashboard. |
| `TRIGGER_SECRET_KEY` | yes | Trigger.dev project, production environment. |
| `OUTLOOK_CLIENT_ID`, `OUTLOOK_CLIENT_SECRET`, `OUTLOOK_REDIRECT_URI` | no | Azure app registration for Outlook inbox sync. |
| `SLACK_*` | no | A Slack app, if you use the Slack inbox. |
| `XERO_*`, `QUICKBOOKS_*`, `FORTNOX_*` | no | Accounting integrations. |
| `STRIPE_SECRET_KEY`, `STRIPE_PUBLISHABLE_KEY`, `STRIPE_CONNECT_CLIENT_ID`, `STRIPE_CONNECT_WEBHOOK_SECRET` | no | Stripe Connect for invoice payments. |

### Dashboard (`apps/dashboard`)

Build arguments (inlined by `next build`; changing one needs a rebuild):

| Variable | Required | Where it comes from |
| --- | --- | --- |
| `NEXT_PUBLIC_URL` | yes | `https://midday.fredflix.be` |
| `NEXT_PUBLIC_API_URL` | yes | `https://api.midday.fredflix.be` |
| `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | yes | Supabase project settings > API. Resumable uploads derive their endpoint from the URL. |
| `NEXT_PUBLIC_DESKTOP_SCHEME` | yes | `midday` for the production desktop build (`midday-dev` for `tauri:dev`). |
| `NEXT_PUBLIC_GOOGLE_API_KEY` | no | Google Maps key for address autocomplete. |
| `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` | no | Stripe Connect. |

Runtime environment:

| Variable | Required | Where it comes from |
| --- | --- | --- |
| `API_INTERNAL_URL` | no | Private URL of the API container for server-side requests. |
| `SUPABASE_SECRET_KEY` | yes | Supabase project settings > API. |
| `INVOICE_JWT_SECRET`, `FILE_KEY_SECRET`, `WEBHOOK_SECRET_KEY`, `MIDDAY_CACHE_API_SECRET`, `NEXT_SERVER_ACTIONS_ENCRYPTION_KEY` | yes | Shared secrets above. |
| `OPENAI_API_KEY` | yes | OpenAI. |
| `AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT`, `AZURE_DOCUMENT_INTELLIGENCE_KEY` | no | Azure Document Intelligence. |
| `PLAIN_API_KEY` | no | Plain support tickets. |
| `GMAIL_CLIENT_ID`, `GMAIL_CLIENT_SECRET`, `GMAIL_REDIRECT_URI` | yes for Gmail inbox | The internal Google OAuth client with Gmail scopes (FF-1407). |
| `OUTLOOK_CLIENT_ID`, `OUTLOOK_CLIENT_SECRET`, `OUTLOOK_REDIRECT_URI` | no | Azure app registration. |

### Jobs (`packages/jobs`, Trigger.dev)

| Variable | Required | Where it comes from |
| --- | --- | --- |
| `DATABASE_URL` | yes | Supabase session pooler. |
| `SUPABASE_URL`, `SUPABASE_SECRET_KEY` | yes | Nearly every job reads or writes the `vault` bucket. |
| `ENABLEBANKING_APPLICATION_ID`, `ENABLE_BANKING_KEY_CONTENT`, `ENABLEBANKING_REDIRECT_URL` | yes | `@midday/banking` validates these on load, so an unset value stops the institution sync at startup rather than at runtime. |
| `MIDDAY_ENCRYPTION_KEY`, `INTERNAL_API_KEY` | yes | Shared secrets above. |
| `INVOICE_JWT_SECRET` | for invoicing | Signs the public invoice links in invoice emails. Same value as the API. |
| `GMAIL_*` / `OUTLOOK_*` | for inbox sync | Same OAuth client as the API. |
| `XERO_*`, `QUICKBOOKS_*`, `FORTNOX_*` | for accounting export | Token refresh needs the client credentials. |
| `MISTRAL_API_KEY`, `OPENAI_API_KEY` | no | Document OCR fallback; Slack receipt summaries. |
| `DASHBOARD_URL`, `API_URL` | yes | Public URLs. Unset in production is a startup error, not a fallback. |
| `RESEND_API_KEY`, `RESEND_AUDIENCE_ID` | no / no | Resend, for the invite and onboarding emails; those tasks fail without a key. |
| `EMAIL_FROM`, `EMAIL_FROM_NAME` | yes to send / no | Same value as the API. |
| `BANK_SYNC_SCHEDULER_ENABLED`, `INVOICE_SCHEDULER_ENABLED`, `NO_MATCH_SCHEDULER_ENABLED`, `RATES_SCHEDULER_ENABLED`, `SYNC_INSTITUTIONS_ENABLED` | no | Scheduled tasks run unless set to `false`. They used to run only in Midday's own production environment. `packages/jobs/README.md` lists every schedule and its cron. |
| `TRIGGER_PROJECT_ID` | yes | Read by `trigger.config.ts`, and a repository secret for the deploy workflow. |
| `INSIGHTS_ENABLED` | no | Weekly insight emails, off unless exactly `true`. No schedule is registered for the dispatcher, so this alone starts nothing. |
| `GOOGLE_GENERATIVE_AI_API_KEY` | yes | Embeddings. |

### Repository secrets (GitHub Actions)

| Secret | Purpose |
| --- | --- |
| `DATABASE_SESSION_POOLER` | Lets the `migrate` job in `ci.yml` apply pending migrations on push to `main`. When unset the job skips with a notice — which is what it did for as long as `db:migrate` was broken. |
| `SUPABASE_URL` | The project's API URL. With the next one, lets `supabase-keepalive.yml` touch the API twice a week so a free project never pauses. When either is unset the job skips with a notice. |
| `SUPABASE_SECRET_KEY` | The project's secret (service role) key, so the keepalive call does not depend on what RLS allows anonymously. |
| `TRIGGER_ACCESS_TOKEN`, `TRIGGER_PROJECT_ID` | Let `trigger-deploy.yml` ship `packages/jobs` on push to `main`. Both must be set or the job skips with a notice. The token comes from the Trigger.dev account (Personal Access Token); the project id is the `proj_…` reference on the project. |

## Local development

```bash
bun install
cp apps/api/.env.example apps/api/.env
cp apps/dashboard/.env.example apps/dashboard/.env
# fill both in, then
bun run dev:api
bun run dev:dashboard
```

`bun run typecheck`, `bun run lint` and `bun run test` are what CI runs.
