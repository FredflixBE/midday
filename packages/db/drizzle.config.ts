import type { Config } from "drizzle-kit";

export default {
  schema: "./src/schema.ts",
  out: "./migrations",
  dialect: "postgresql",
  // The same casing the runtime client uses (src/client.ts). Without it,
  // columns declared without an explicit name — billingEmail, isActive —
  // would be created camelCase here and queried snake_case there.
  casing: "snake_case",
  dbCredentials: {
    url: process.env.DATABASE_SESSION_POOLER!,
  },
} satisfies Config;
