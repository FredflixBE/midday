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
| Background jobs (`packages/jobs`) | Trigger.dev (free plan) | Deployed by its own workflow (see the job-system epic). |
| Worker (`apps/worker`) | Dokploy, `apps/worker/Dockerfile` | Only until every job has moved to Trigger.dev (FF-1368); then it is deleted. |
| Redis | On the VPS | Cache (`REDIS_URL`) and BullMQ queue (`REDIS_QUEUE_URL`); one instance is fine. |
| Bank data | Enable Banking (required), GoCardless (optional) | Plaid and Teller are gone. |
| Email | Resend | Transactional email only. |
| Login | Google OAuth through Supabase Auth | Plus an internal Google OAuth client with Gmail scopes for inbox sync. |
| Desktop app (`apps/desktop`) | Built locally on a Mac | No updater. See `apps/desktop/README.md`. |
| CI | GitHub Actions, `ubuntu-latest` | `ci.yml` typechecks, lints and tests; on push to `main` it first applies schema migrations. Dokploy deploys on the same push. |

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
   configure auth, apply the schema once with the bootstrap script from FF-1395,
   and keep it current with `bun run db:migrate` (what CI runs on `main`).
3. **FF-1371 Accounts and DNS.** The external services: Google Cloud OAuth
   clients, Enable Banking application, Resend, Trigger.dev, DNS records.
4. **FF-1370 Make the code self-hostable.** Remove every hardcoded `midday.ai`
   dependency and the remaining startup blockers.
5. **FF-1368 One job system.** Move every background job to Trigger.dev and
   delete the BullMQ worker.
6. **FF-1372 Deploy and go-live on Dokploy.** The two Dokploy applications,
   env vars, domains, and the go-live checklist.

## Environment variables

One example file per deployable, containing only variables that still exist:

- `apps/api/.env.example`
- `apps/dashboard/.env.example`
- `packages/jobs/.env.example`
- `apps/worker/.env.example` (until FF-1368)

Copy the example to `.env` next to it for local development. In Dokploy, paste
the API values as environment, and split the dashboard file: every
`NEXT_PUBLIC_*` line is a build argument, the rest is environment. In
Trigger.dev, set the jobs values on the project.

### Shared secrets

Generate each with `openssl rand -hex 32` unless stated otherwise, and use the
same value everywhere the name appears.

| Variable | Used by | Purpose |
| --- | --- | --- |
| `MIDDAY_ENCRYPTION_KEY` | api, jobs | Encrypts provider tokens at rest. 64 hex characters. |
| `INTERNAL_API_KEY` | api, jobs, worker | Service-to-service calls into the API. |
| `INVOICE_JWT_SECRET` | api, dashboard, worker | Signs public invoice links. |
| `FILE_KEY_SECRET` | api, dashboard | Signs file download keys. |
| `WEBHOOK_SECRET_KEY` | dashboard | Verifies the Supabase registration webhook. |
| `MIDDAY_CACHE_API_SECRET` | dashboard | Protects the cache revalidation route. |
| `NEXT_SERVER_ACTIONS_ENCRYPTION_KEY` | dashboard | `openssl rand -base64 32`. Must be identical across replicas. |
| `INBOX_WEBHOOK_USERNAME` / `INBOX_WEBHOOK_PASSWORD` | api | Basic auth on the inbound inbox email webhook. |

### API (`apps/api`)

| Variable | Required | Where it comes from |
| --- | --- | --- |
| `NODE_ENV`, `LOG_LEVEL`, `LOG_PRETTY` | yes | `production`, `info`, `false` in Dokploy. |
| `PORT` | no | Defaults to 3000; the Dockerfile sets 8080. |
| `MIDDAY_DASHBOARD_URL`, `DASHBOARD_URL`, `ALLOWED_API_ORIGINS` | yes | The dashboard's public URL (`https://midday.fredflix.be`). |
| `MIDDAY_API_URL`, `API_URL` | yes | The API's public URL (`https://api.midday.fredflix.be`). OAuth redirect URLs below are built from it. |
| `SUPABASE_URL`, `SUPABASE_SECRET_KEY` | yes | Supabase project settings > API. |
| `SUPABASE_JWT_SECRET` | no | Legacy HS256 fallback; drop once the legacy JWT secret is revoked. |
| `DATABASE_URL` | yes | Supabase > Database > session pooler, port 5432. |
| `DATABASE_SESSION_POOLER` | yes | Same value; used by drizzle-kit and the CI migrate job (as a repository secret). |
| `DB_POOL_MAX` | no | Pool size outside development (default 10). |
| `REDIS_URL`, `REDIS_QUEUE_URL` | yes | The VPS Redis. |
| `ENABLEBANKING_APPLICATION_ID`, `ENABLE_BANKING_KEY_CONTENT`, `ENABLEBANKING_REDIRECT_URL` | yes | Enable Banking control panel; the redirect URL points at the API. The API does not start without these. |
| `GOCARDLESS_SECRET_ID`, `GOCARDLESS_SECRET_KEY` | no | GoCardless Bank Account Data portal. Leave empty to disable the provider. |
| `R2_ENDPOINT`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET_NAME` | no | Cloudflare R2 bucket for institution logos. Leave empty to serve provider logo URLs directly. |
| `RESEND_API_KEY`, `RESEND_AUDIENCE_ID` | no / no | Resend; the audience receives new sign-ups. The API boots without a key, and the requests that send email fail with a clear error until one is set. |
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
| `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`, `NEXT_PUBLIC_SUPABASE_ID` | yes | Supabase project settings > API. |
| `NEXT_PUBLIC_DESKTOP_SCHEME` | yes | `midday` for the production desktop build (`midday-dev` for `tauri:dev`). |
| `NEXT_PUBLIC_GOOGLE_API_KEY` | no | Google Maps key for address autocomplete. |
| `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` | no | Stripe Connect. |

Runtime environment:

| Variable | Required | Where it comes from |
| --- | --- | --- |
| `API_INTERNAL_URL` | no | Private URL of the API container for server-side requests. |
| `SUPABASE_SECRET_KEY` | yes | Supabase project settings > API. |
| `REDIS_URL` | yes | The VPS Redis. |
| `INVOICE_JWT_SECRET`, `FILE_KEY_SECRET`, `WEBHOOK_SECRET_KEY`, `MIDDAY_CACHE_API_SECRET`, `NEXT_SERVER_ACTIONS_ENCRYPTION_KEY` | yes | Shared secrets above. |
| `RESEND_API_KEY`, `RESEND_AUDIENCE_ID` | yes / no | Resend. |
| `OPENAI_API_KEY` | yes | OpenAI. |
| `AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT`, `AZURE_DOCUMENT_INTELLIGENCE_KEY` | no | Azure Document Intelligence. |
| `PLAIN_API_KEY` | no | Plain support tickets. |
| `GMAIL_CLIENT_ID`, `GMAIL_CLIENT_SECRET`, `GMAIL_REDIRECT_URI` | yes for Gmail inbox | The internal Google OAuth client with Gmail scopes (FF-1407). |
| `OUTLOOK_CLIENT_ID`, `OUTLOOK_CLIENT_SECRET`, `OUTLOOK_REDIRECT_URI` | no | Azure app registration. |

### Jobs (`packages/jobs`, Trigger.dev)

| Variable | Required | Where it comes from |
| --- | --- | --- |
| `DATABASE_URL` | yes | Supabase session pooler. |
| `MIDDAY_ENCRYPTION_KEY`, `INTERNAL_API_KEY` | yes | Shared secrets above. |
| `DASHBOARD_URL`, `API_URL` | yes | Public URLs. |
| `RESEND_API_KEY`, `RESEND_AUDIENCE_ID` | no / no | Resend, for the invite and onboarding emails; those tasks fail without a key. |
| `BANK_SYNC_SCHEDULER_ENABLED`, `INVOICE_SCHEDULER_ENABLED`, `NO_MATCH_SCHEDULER_ENABLED` | no | Scheduled tasks run unless set to `false`. They used to run only in Midday's own production environment. |
| `GOOGLE_GENERATIVE_AI_API_KEY` | yes | Embeddings. |

### Worker (`apps/worker`, until FF-1368)

Same database, Supabase, Redis, banking, Resend and AI values as the API, plus
`PORT=8080` and `INSIGHTS_ENABLED` (`true` to send weekly insight emails). The
scheduled processors run unless `SYNC_INSTITUTIONS_ENABLED`,
`RATES_SCHEDULER_ENABLED` or `NO_MATCH_SCHEDULER_ENABLED` is set to `false`;
`WORKER_ENV=staging` makes the invoice processors log instead of act. See
`apps/worker/.env.example`.

### Repository secrets (GitHub Actions)

| Secret | Purpose |
| --- | --- |
| `DATABASE_SESSION_POOLER` | Lets the `migrate` job in `ci.yml` apply pending migrations on push to `main`. When unset the job skips with a notice. |

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
