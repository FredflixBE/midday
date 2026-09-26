import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { AUTH_USER, assertDevelopmentDatabase, readEnvFile } from "./env";

/**
 * Reads rows back with the service role, so a test that writes can check the
 * database holds what it held before, rather than trusting the screen.
 */
export function database() {
  assertDevelopmentDatabase();
  const env = readEnvFile("dashboard");

  return createClient(env.NEXT_PUBLIC_SUPABASE_URL!, env.SUPABASE_SECRET_KEY!, {
    auth: { persistSession: false },
  });
}

/** The user global-setup signed in as. */
export function signedInUserId(): string {
  return JSON.parse(readFileSync(AUTH_USER, "utf8")).id;
}
