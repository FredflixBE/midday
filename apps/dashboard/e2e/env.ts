import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describeTarget } from "@midday/db/script-guard";

// The smoke suite runs its own API and dashboard next to the ones on
// 3001/3003, so it never answers with code from another checkout.
export const DASHBOARD_PORT = Number(process.env.SMOKE_DASHBOARD_PORT ?? 3101);
export const API_PORT = Number(process.env.SMOKE_API_PORT ?? 3103);

export const DASHBOARD_URL = `http://localhost:${DASHBOARD_PORT}`;
export const API_URL = `http://localhost:${API_PORT}`;

export const AUTH_STATE = join(__dirname, ".auth", "state.json");
export const AUTH_USER = join(__dirname, ".auth", "user.json");

const APPS = join(__dirname, "..", "..");

/** Reads a `.env` file without touching `process.env`. */
export function readEnvFile(app: "api" | "dashboard") {
  const text = readFileSync(join(APPS, app, ".env"), "utf8");
  const env: Record<string, string> = {};

  for (const line of text.split("\n")) {
    const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (match) env[match[1]!] = match[2]!.replace(/^"|"$/g, "");
  }

  return env;
}

/**
 * The suite signs in and clicks through real screens, so it must never run
 * against the production books.
 *
 * The label sits beside the connection it describes (FF-1683): the API's
 * `.env` declares `DATABASE_ENVIRONMENT` next to its `DATABASE_URL`. The
 * suite signs in and reads rows back with the dashboard's Supabase keys,
 * though, so the dashboard's project has to be the one that label is about.
 */
export function assertDevelopmentDatabase() {
  const api = readEnvFile("api");
  const target = describeTarget(api.DATABASE_URL, api as NodeJS.ProcessEnv);
  const dashboardProject = new URL(
    readEnvFile("dashboard").NEXT_PUBLIC_SUPABASE_URL ?? "http://unset",
  ).hostname.split(".")[0];

  if (target.environment !== "development") {
    throw new Error(
      `Smoke tests only run against a development database; apps/api/.env declares ${target.environment}`,
    );
  }

  if (!target.project || target.project !== dashboardProject) {
    throw new Error(
      `apps/dashboard/.env's Supabase project (${dashboardProject}) is not the development database apps/api/.env points at (${target.project ?? "none"})`,
    );
  }
}
