## API

### Environment Variables

The API requires the following environment variables:

#### Redis Configuration
```bash
# Local development (Docker):

# Production:
```

Two separate Redis instances are used:


#### Local Development Setup

1. **Start Redis with Docker:**
   ```bash
   docker run -d --name redis -p 6379:6379 redis:alpine
   ```

2. **Set environment variable:**
   ```bash
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