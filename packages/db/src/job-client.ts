import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import type { Database } from "./client";
import * as schema from "./schema";
import { guardScriptConnection } from "./script-guard";

const isDevelopment = process.env.NODE_ENV === "development";

/**
 * Creates a new job-optimized database instance.
 *
 * - Single connection per job (max: 1) to avoid flooding Supabase pooler
 * - Separate disconnect function for lifecycle management
 */
export const createJobDb = () => {
  // Inert unless the process was started from a script; see script-guard.ts.
  guardScriptConnection(process.env.DATABASE_URL);

  const jobPool = new Pool({
    connectionString: process.env.DATABASE_URL!,
    max: 1,
    idleTimeoutMillis: isDevelopment ? 5000 : 60000,
    connectionTimeoutMillis: 15000,
    maxUses: 0,
    allowExitOnIdle: true,
  });

  const db = drizzle(jobPool, {
    schema,
    casing: "snake_case",
  });

  return {
    db: db as Database,
    disconnect: () => jobPool.end(),
  };
};
