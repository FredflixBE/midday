## API

### Environment variables

`apps/api/.env.example` is the full list, with a note on where each value comes
from. `SELF_HOSTING.md` says which are required.

The one that has to be right before anything else works:

```bash
DATABASE_URL=postgresql://...  # Supabase session pooler
```

### Development

```bash
bun dev
```

### Production

```bash
bun start
```

### Caching

The API keeps a few rarely-changing lookups in memory (`@midday/cache`):

- **apiKeyCache** — API key lookups (30 min TTL)
- **userCache** — user data (30 min TTL)
- **teamCache** — team access (30 min TTL)
- **teamPermissionsCache** — team permission lookups (30 min TTL)
- **bankingCache** — provider tokens and institutions (30 min default TTL)
- **connectorsCache** — Composio connectors (24h TTL)

These used to live in Redis so several API instances could share them. This
deployment runs one instance, so they are per-process — see
`packages/cache/src/memory-cache.ts`, which spells out what that changes if a
second instance is ever added.
