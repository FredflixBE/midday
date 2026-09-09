import { createLoggerWithContext } from "@midday/logger";
import type { ExtractTablesWithRelations, SQL } from "drizzle-orm";
import type { NodePgQueryResultHKT } from "drizzle-orm/node-postgres";
import { drizzle } from "drizzle-orm/node-postgres";
import type { PgTransaction } from "drizzle-orm/pg-core";
import { Pool } from "pg";
import { createDrizzleLogger, instrumentPool } from "./instrument";
import * as schema from "./schema";

const logger = createLoggerWithContext("db");

const isDevelopment = process.env.NODE_ENV === "development";
const isProduction = process.env.NODE_ENV === "production";
const DEBUG_PERF = process.env.DEBUG_PERF === "true";
const DB_POOL_EVENT_LOGGING = process.env.DB_POOL_EVENT_LOGGING === "true";

const connectionConfig = {
  max: isDevelopment ? 8 : Number(process.env.DB_POOL_MAX) || 10,
  min: isDevelopment ? 0 : 1,
  idleTimeoutMillis: isDevelopment ? 5000 : 10000,
  connectionTimeoutMillis: 5000,
  maxUses: isDevelopment ? 100 : 7500,
  allowExitOnIdle: !isProduction,
  keepAlive: true,
  keepAliveInitialDelayMillis: 10_000,
  ssl: isDevelopment ? false : { rejectUnauthorized: false },
};

const drizzleLogger = DEBUG_PERF ? createDrizzleLogger() : undefined;

function getPgErrorDetails(error: unknown) {
  const details: Record<string, unknown> = {};

  if (error && typeof error === "object") {
    const err = error as Record<string, unknown>;
    const fields = [
      "name",
      "message",
      "code",
      "errno",
      "syscall",
      "address",
      "port",
      "stack",
    ];

    for (const field of fields) {
      if (err[field] !== undefined) {
        details[field] = err[field];
      }
    }
  } else {
    details.message = String(error);
  }

  return details;
}

// DATABASE_URL is the Supabase session pooler. Left unset (tests, typecheck)
// the pool is created but never connects.
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ...connectionConfig,
});

if (DEBUG_PERF) instrumentPool(pool, "db");

export function getPoolStats() {
  return {
    total: pool.totalCount,
    idle: pool.idleCount,
    waiting: pool.waitingCount,
  };
}

pool.on("error", (err) => {
  logger.error("db pool: idle client error", {
    ...getPgErrorDetails(err),
    stats: getPoolStats(),
  });
});

if (DB_POOL_EVENT_LOGGING) {
  pool.on("connect", () => {
    logger.info("db pool: client connected", { stats: getPoolStats() });
  });

  pool.on("acquire", () => {
    logger.info("db pool: client acquired", { stats: getPoolStats() });
  });

  pool.on("remove", () => {
    logger.info("db pool: client removed", { stats: getPoolStats() });
  });
}

export const db = drizzle(pool, {
  schema,
  casing: "snake_case",
  logger: drizzleLogger,
});

export const connectDb = async () => {
  return db;
};

export type Database = typeof db;

export type TransactionClient = PgTransaction<
  NodePgQueryResultHKT,
  typeof schema,
  ExtractTablesWithRelations<typeof schema>
>;

/** Use in query functions that should work both standalone and within transactions */
export type DatabaseOrTransaction = Database | TransactionClient;

/**
 * Run a raw SQL statement and return its rows, whatever shape the driver
 * hands back.
 */
export async function executeRows<
  TRow extends Record<string, unknown> = Record<string, unknown>,
>(database: DatabaseOrTransaction, query: SQL): Promise<TRow[]> {
  const result = await database.execute(query);
  if (Array.isArray(result)) {
    return result as TRow[];
  }
  return (result as { rows: TRow[] }).rows;
}

/**
 * Close the database pool gracefully
 */
export const closeDb = async (): Promise<void> => {
  await pool.end();
};
