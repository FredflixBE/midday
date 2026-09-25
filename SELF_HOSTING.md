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
`NEXT_PUBLIC_*` line is a build argument, the rest is environment — see
[Deploying on Dokploy](#deploying-on-dokploy), which gives both forms field by
field. In Trigger.dev, set the jobs values on the project.

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
| `DATABASE_ENVIRONMENT` | yes | `production` here, `development` in a `.env` on your machine. Nothing else reads it; the maintenance scripts do, and refuse to act unlabelled. See [What a script may do to a database](#what-a-script-may-do-to-a-database). |
| `DB_POOL_MAX` | no | Pool size outside development (default 10). |
| `ENABLEBANKING_APPLICATION_ID`, `ENABLE_BANKING_KEY_CONTENT`, `ENABLEBANKING_REDIRECT_URL` | yes | Enable Banking control panel. The redirect URL points at the **dashboard**, not the API — the callback is handled by `apps/dashboard/src/app/api/enablebanking/session/route.ts`, so the value is `<DASHBOARD_URL>/api/enablebanking/session`. Register that exact URL with Enable Banking too. The API does not start without these three. |
| `GOCARDLESS_SECRET_ID`, `GOCARDLESS_SECRET_KEY` | no | GoCardless Bank Account Data portal. Leave empty to disable the provider. |
| `RESEND_API_KEY`, `RESEND_AUDIENCE_ID` | no / no | Resend; the audience receives new sign-ups. The API boots without a key, and the requests that send email fail with a clear error until one is set. |
| `EMAIL_FROM`, `EMAIL_FROM_NAME` | yes to send / no | The address email is sent from, e.g. `Midday <midday@fredflix.be>`. Its domain must be verified with Resend or every message fails DKIM. Invoices go out under the team's name from this address. |
| `INBOX_FORWARDING_DOMAIN` | no | Domain receipts may be forwarded to, e.g. `inbox.fredflix.be`. Requires an inbound email provider posting to `/webhooks/inbox`. Unset means that route is not mounted and the dashboard hides the address; Gmail sync and manual upload are unaffected. Set `NEXT_PUBLIC_INBOX_FORWARDING_DOMAIN` to the same value for the dashboard. |
| `ALLOWED_ASSET_HOSTS` | no | Extra hostnames the renderer may fetch a logo or avatar from, comma-separated. The Supabase storage host and your own `CDN_URL`, `DASHBOARD_URL` and `API_URL` are always allowed. |
| `OPENAI_API_KEY`, `GOOGLE_GENERATIVE_AI_API_KEY`, `MISTRAL_API_KEY` | yes / yes / no | The assistant, embeddings, and document OCR. |
| `COMPOSIO_API_KEY` | no | AI tool connectors. |
| `EXA_API_KEY` | no | Exa web search. Only the health probe reads it; unset means that probe reports the integration as unconfigured. |
| `COMPANY_ENRICH_API_KEY` | no | CompanyEnrich customer enrichment. Leave unset — the service refuses registration from Belgium, and every entry point is gated behind the key, so unset hides the feature rather than offering a button that only errors. |
| `API_RATE_LIMIT`, `CHAT_RATE_LIMIT`, `MCP_API_RATE_LIMIT` | no | Requests per signed-in user per 10-minute window: the REST routes (default 1000), the AI chat route (default 100), and the MCP route (falls back to `API_RATE_LIMIT`). Worth setting deliberately once the API answers on a public domain. |
| `PLAIN_API_KEY` | no | Plain support tickets; the API only probes it for health. |
| `GMAIL_CLIENT_ID`, `GMAIL_CLIENT_SECRET`, `GMAIL_REDIRECT_URI` | yes for Gmail inbox | The internal Google OAuth client with Gmail scopes (FF-1407); same values as the dashboard. |
| `TRIGGER_SECRET_KEY` | yes | Trigger.dev project, production environment. |
| `DEVELOPER_EMAIL` | for Settings → Admin | The one email address allowed to run the maintenance jobs by hand. Those jobs act on the whole deployment, not on one team. Unset means nobody: the Admin tab is hidden and its mutations refuse. A refusal is logged with the address it saw, so a mismatch is one log line rather than a tab that never appears. |
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
| `NEXT_SERVER_ACTIONS_ENCRYPTION_KEY` | yes | `openssl rand -base64 32`. A build argument **and** a runtime variable, with the same value in both: Next encrypts server-action arguments with it at build and decrypts with it at runtime. |
| `NEXT_PUBLIC_INBOX_FORWARDING_DOMAIN` | no | Same value as the API's `INBOX_FORWARDING_DOMAIN`. Unset hides the forwarding address in the dashboard. |
| `NEXT_PUBLIC_GOOGLE_API_KEY` | no | Google Maps key for address autocomplete. |
| `NEXT_PUBLIC_DESKTOP_SCHEME` | no | Deep-link scheme of the desktop build, if you install one. Every reader falls back to `hq`, which is the production scheme; `hq-dev` matches `tauri:dev`. |

There is deliberately no `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY`. Stripe Connect invoice payments are not part of this fork, the payment sheet only renders for a team that has completed Stripe Connect onboarding, and a declared argument nobody passes is an empty string in the bundle rather than an error — so declaring it would only suggest it does something.

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
| `DASHBOARD_URL`, `API_URL` | yes | Public URLs. Unset in production is a startup error, not a fallback. The bank sync jobs call the API at `API_URL`. |
| `API_INTERNAL_URL` | no | A private address for the API that the jobs can reach, used instead of `API_URL` for their calls to it. Trigger.dev Cloud reaches only the public URL, so leave it unset there. |
| `RESEND_API_KEY`, `RESEND_AUDIENCE_ID` | no / no | Resend, for the invite and onboarding emails; those tasks fail without a key. |
| `EMAIL_FROM`, `EMAIL_FROM_NAME` | yes to send / no | Same value as the API. |
| `BANK_SYNC_SCHEDULER_ENABLED`, `INVOICE_SCHEDULER_ENABLED`, `NO_MATCH_SCHEDULER_ENABLED`, `RATES_SCHEDULER_ENABLED`, `SYNC_INSTITUTIONS_ENABLED` | no | Jobs run unless set to `false`. They used to run only in Midday's own production environment. `SYNC_INSTITUTIONS_ENABLED` now gates a task with no cron, started from Settings → Admin, and `BANK_SYNC_SCHEDULER_ENABLED` gates one of each; `packages/jobs/README.md` lists what is scheduled and what is not. |
| `MATCH_AUTO_ENABLED` | for automatic matching | Off unless exactly `true`. Attaches an invoice to its payment without asking when the match clears the team's calibrated threshold. Unset is **silent**: `resolveMatchType` never returns `auto_matched`, so every pair waits for a click and nothing says why. The matcher runs in the jobs, so this belongs in the Trigger.dev environment — setting it on the API changes nothing. |
| `INVOICE_JOBS_DRY_RUN` | no | Off unless set. Makes the two recurring-invoice jobs log which invoices they would generate and who they would email, and send nothing. Worth one run before letting invoicing send for real. |
| `INSIGHTS_ENABLED` | no | Weekly insight emails, off unless exactly `true`. No schedule is registered for the dispatcher, so this alone starts nothing. |
| `GOOGLE_GENERATIVE_AI_API_KEY` | yes | Embeddings. |

### Repository secrets (GitHub Actions)

| Secret | Purpose |
| --- | --- |
| `DATABASE_SESSION_POOLER` | Lets the `migrate` job in `ci.yml` apply pending migrations on push to `main`. When unset the job skips with a notice — which is what it did for as long as `db:migrate` was broken. |
| `SUPABASE_URL` | The project's API URL. With the next one, lets `supabase-keepalive.yml` touch the API twice a week so a free project never pauses. When either is unset the job skips with a notice. |
| `SUPABASE_SECRET_KEY` | The project's secret (service role) key, so the keepalive call does not depend on what RLS allows anonymously. |
| `TRIGGER_ACCESS_TOKEN` | Lets `trigger-deploy.yml` ship `packages/jobs` on push to `main`. When unset the job skips with a notice. A Personal Access Token from the Trigger.dev account; the project itself is named in `trigger.config.ts`. |

## Deploying on Dokploy

Two applications on one VPS, both built by Dokploy from this repository on
every push to `main`. Everything either form needs is on this page; you should
not have to open a Dockerfile to fill one in.

### What both applications share

| Field | Value |
| --- | --- |
| Provider | GitHub, `FredflixBE/midday`, branch `main` |
| Build type | Dockerfile |
| **Build context** | `.` — the repository **root**, for both |
| Auto deploy | on: a push to `main` rebuilds |

The build context is the repository root, not the application directory. Both
Dockerfiles copy the whole repository and then `turbo prune` the workspace they
need, so a context of `apps/api` or `apps/dashboard` fails at the first copy.

Neither image needs `.git-commit-sha`: Dokploy builds from a plain checkout,
and the optional `GIT_COMMIT_SHA` build argument covers the stamp.

### API application

| Field | Value |
| --- | --- |
| Dockerfile path | `apps/api/Dockerfile` |
| Port | `8080` |
| Health path | `/health` |
| Domain | `api.midday.fredflix.be` |
| Build arguments | none (only the optional `GIT_COMMIT_SHA`) |

Everything else is runtime environment. Paste `apps/api/.env.example` and fill
it in — every value's origin is in [API (`apps/api`)](#api-appsapi) above —
changing these four lines from their local-development defaults:

```
NODE_ENV=production
LOG_LEVEL=info
LOG_PRETTY=false
PORT=8080
```

and these, which are localhost in the example and must be the public domains:

```
DASHBOARD_URL=https://midday.fredflix.be
ALLOWED_API_ORIGINS=https://midday.fredflix.be
API_URL=https://api.midday.fredflix.be
GMAIL_REDIRECT_URI=https://api.midday.fredflix.be/apps/gmail/oauth-callback
OUTLOOK_REDIRECT_URI=https://api.midday.fredflix.be/apps/outlook/oauth-callback
```

`ENABLEBANKING_REDIRECT_URL` is the exception in that list: it points at the
**dashboard**, because the dashboard handles the callback.

```
ENABLEBANKING_REDIRECT_URL=https://midday.fredflix.be/api/enablebanking/session
```

The API refuses to start in production with `DASHBOARD_URL` or `API_URL` unset,
and refuses to start at all without the three `ENABLEBANKING_*` values. Those
are the two failures to expect from an incomplete paste, and both are loud.

### Dashboard application

| Field | Value |
| --- | --- |
| Dockerfile path | `apps/dashboard/Dockerfile` |
| Port | `3000` |
| Health path | `/api/health` |
| Domain | `midday.fredflix.be` |

**Build arguments.** This is the whole list; anything not here is runtime.

```
NEXT_PUBLIC_URL=https://midday.fredflix.be
NEXT_PUBLIC_API_URL=https://api.midday.fredflix.be
NEXT_PUBLIC_SUPABASE_URL=https://<project-ref>.supabase.co
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=<publishable key>
NEXT_PUBLIC_GOOGLE_API_KEY=<Maps key, or omit>
NEXT_PUBLIC_DESKTOP_SCHEME=hq
NEXT_SERVER_ACTIONS_ENCRYPTION_KEY=<openssl rand -base64 32>
```

`NEXT_PUBLIC_INBOX_FORWARDING_DOMAIN` is an eighth, needed only if you run
inbound email; give it the same value as the API's `INBOX_FORWARDING_DOMAIN`.

**Runtime environment.** `NEXT_SERVER_ACTIONS_ENCRYPTION_KEY` appears in both
lists, with the same value in each — see below.

```
SUPABASE_SECRET_KEY=<secret (service role) key>
INVOICE_JWT_SECRET=<same as the API>
FILE_KEY_SECRET=<same as the API>
WEBHOOK_SECRET_KEY=<shared secret>
MIDDAY_CACHE_API_SECRET=<shared secret>
NEXT_SERVER_ACTIONS_ENCRYPTION_KEY=<the same value as the build argument>
OPENAI_API_KEY=<key>
GMAIL_CLIENT_ID=<same client as the API>
GMAIL_CLIENT_SECRET=<same client as the API>
GMAIL_REDIRECT_URI=https://api.midday.fredflix.be/apps/gmail/oauth-callback
```

Optional on top of that: `API_INTERNAL_URL` (the API's private address, which
skips the public hop for server-side requests), the two
`AZURE_DOCUMENT_INTELLIGENCE_*` values, `PLAIN_API_KEY`, and the three
`OUTLOOK_*` values.

### The split that fails silently

Next inlines every `NEXT_PUBLIC_*` value at `next build`. Supplied as runtime
environment instead of as a build argument, it is simply absent from the
bundle, and **the build succeeds anyway** — an unset build argument is an
empty string, not an error, so nothing warns.

What you get is a dashboard that loads and then fails on every request. The
value is interpolated into a URL, so `NEXT_PUBLIC_API_URL` missing produces
requests to `https://midday.fredflix.be/undefined/trpc` — the literal word
`undefined`, resolved against the dashboard's own origin. If a deployed
dashboard renders but nothing in it works, look at a failing request's URL
before anything else.

The same split is why changing one of these values needs a rebuild, not a
restart.

`NEXT_SERVER_ACTIONS_ENCRYPTION_KEY` is the one variable that is genuinely
both. Next encrypts server-action arguments with it at build and decrypts with
it at runtime, so the two copies have to hold the same value; supplied only at
runtime, the dashboard throws on its first server action.

## Rolling back

Three things deploy from a push to `main`, and they roll back separately —
or not at all.

| What | How it deploys | How it comes back |
| --- | --- | --- |
| API and dashboard | Dokploy, on the push | Redeploy a previous deployment, or push a revert |
| Background jobs | `trigger-deploy.yml` → Trigger.dev | Roll back in Trigger.dev, or push a revert |
| Database schema | `migrate` job in `ci.yml` | **It does not.** See below |

### Rolling back the application

Redeploy the previous deployment in Dokploy, or push a revert commit and let
the normal path rebuild. A revert is slower but leaves `main` telling the
truth, which matters when the next person looks.

Two things a redeploy does **not** undo:

- **Configuration.** Dokploy rebuilds the old commit with the environment and
  build arguments currently in the form. Rolling the code back does not roll
  back a value you changed since — and for the dashboard, a build argument you
  changed is baked into the new image.
- **The jobs.** `packages/jobs` is not part of either Dokploy application. A
  push that changed anything under `packages/` deployed new task code to
  Trigger.dev as well, and redeploying the API does not recall it. Roll that
  back in Trigger.dev, on its own.

### Rolling back the database

It does not roll back with the application, and on this plan it barely rolls
back at all. Supabase Free has daily backups and no point-in-time recovery, so
restoring one means discarding every transaction, receipt and invoice recorded
since it was taken. Against a book of account in daily use that is not a deploy
step; it is a decision with a cost measured in a day of bookkeeping.

So the honest rule is that **a destructive migration is a decision, not a
deploy.** A migration that drops or renames has to be reviewed on the way in,
because there is no way back out. `bun run db:generate` writes the SQL for you
to read before you commit it — that reading is the safety mechanism, and it is
the only one.

### The interaction, which is the part that bites

The `migrate` job and Dokploy's build both start from the same push. The job
runs `bun run db:migrate` immediately and takes about a minute; a dashboard
image takes several. In practice the schema lands first, which is the intent —
but they are two systems reacting to the same event with no ordering between
them, so it is a race that usually goes the right way rather than a guarantee.

What follows from that:

- **Rolling the code back does not roll back the schema it already applied.**
  Old code then runs against a newer database. An additive migration — a new
  table, a new nullable column — survives that fine. A rename or a drop does
  not, and there is no redeploy that fixes it.
- Write migrations so the previous release can still run against them. That
  is what makes a rollback a rollback rather than an outage.

### When a deploy goes bad

1. **Look at what actually changed in the push.** If it touched
   `packages/db/migrations`, you are in the paragraph above and a redeploy
   alone will not do it.
2. **Roll the application back** in Dokploy, both applications if both
   deployed.
3. **Roll the jobs back** in Trigger.dev if the push touched `packages/`.
4. **Leave the schema alone** unless it is the actual fault. Restoring a
   backup costs more than almost any bug.
5. **Push the revert** once the deployment is stable, so `main` and the
   running system agree again.

## Local development

```bash
bun install
cp apps/api/.env.example apps/api/.env
cp apps/dashboard/.env.example apps/dashboard/.env
cp packages/db/.env.example packages/db/.env
# fill both in, then
bun run dev:api
bun run dev:dashboard
```

`bun run typecheck`, `bun run lint` and `bun run test` are what CI runs.

## What a script may do to a database

There are maintenance scripts in four places — `packages/db/src/scripts`,
`packages/jobs/scripts`, `packages/banking/scripts` and
`packages/yuki/scripts` — and several of them write. `bun run` loads a `.env`
from the directory it runs in, so which database a script reaches is decided by
a file nobody looks at, and two Supabase projects differ by one opaque ref.
Remembering which shell is pointed where is not a mitigation; this is.

**Label the connection.** `DATABASE_ENVIRONMENT` goes beside every connection
string, in every `.env` and in both deployed environments:

```
DATABASE_ENVIRONMENT=development   # or production, or test
```

Then, whenever a script runs:

- It **prints what it is about to act on** before it acts — the environment,
  the Supabase project ref, the host and the database. Never the password.
- It **refuses to write to production** unless you say so:

  ```
  CONFIRM_DATABASE_PROD=true bun run --cwd packages/jobs <script>
  ```

  which is the same shape as `CONFIRM_TRIGGER_PROD` for the Trigger scripts.
- It **refuses an unlabelled remote database** too. Unset does not mean safe —
  it means nobody has said, and an unlabelled database might be the real one.
  A database on `localhost` is the exception, so the test database and CI are
  untouched.

A connection that only reads says so where it is opened —
`connectDb({ readOnly: true })` — and then runs anywhere without a
confirmation. It is a property of that call rather than of the process, so a
writing script cannot inherit the exemption by importing a helper out of a
read-only one.

The default is the other way round on purpose: a script written next month is
guarded by its author having done nothing. The guard sits inside `connectDb`
and `createJobDb`, which is how most scripts reach a database. A script that
opens its own `pg` client, or imports the module-scope `db`, has to call
`guardScriptConnection()` by hand — and a test reads every script in all four
directories and fails the build if one of them does not.

None of this affects the API, the jobs or the tests — the guard is inert unless
the process was started from a file under a `scripts/` directory.
