## API

### Environment Variables

The API requires the following environment variables:

#### Redis Configuration
```bash
# Local development (Docker):
REDIS_URL=redis://localhost:6379
REDIS_QUEUE_URL=redis://localhost:6379

# Production:
# REDIS_URL=rediss://:password@...:6379 (cache)
# REDIS_QUEUE_URL=redis://...:6379 (self-hosted Redis - BullMQ queue)
```

Two separate Redis instances are used:

- **`REDIS_URL`** — Redis for caching.
- **`REDIS_QUEUE_URL`** — Redis for BullMQ job queues. BullMQ requires persistent TCP connections with blocking operations, so this must be a plain Redis server rather than an HTTP-based one.

#### Local Development Setup

1. **Start Redis with Docker:**
   ```bash
   docker run -d --name redis -p 6379:6379 redis:alpine
   ```

2. **Set environment variable:**
   ```bash
   export REDIS_URL=redis://localhost:6379
   ```

#### Database Configuration
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

### Cache Implementation

The API uses Redis for caching:

- **apiKeyCache**: Caches API key lookups (30 min TTL)
- **userCache**: Caches user data (30 min TTL)
- **teamCache**: Caches team access permissions (30 min TTL)
- **teamPermissionsCache**: Caches team permission lookups (30 min TTL)

The client gracefully degrades when Redis is unavailable — cache misses return `undefined` and operations no-op instead of throwing.