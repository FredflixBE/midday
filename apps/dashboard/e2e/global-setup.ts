import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import {
  AUTH_STATE,
  AUTH_USER,
  assertDevelopmentDatabase,
  DASHBOARD_PORT,
  readEnvFile,
} from "./env";

// @supabase/ssr splits a session cookie into chunks of this many characters.
const COOKIE_CHUNK = 3180;

/**
 * Signs in without an inbox: the admin API mints a magic link (no email is
 * sent) and verifying its token hash returns a session, which is stored as
 * the cookie the dashboard's middleware reads.
 */
export default async function globalSetup() {
  assertDevelopmentDatabase();

  const env = readEnvFile("dashboard");
  const url = env.NEXT_PUBLIC_SUPABASE_URL;
  const secret = env.SUPABASE_SECRET_KEY;
  const publishable = env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;

  if (!url || !secret || !publishable) {
    throw new Error(
      "apps/dashboard/.env needs NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SECRET_KEY and NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY",
    );
  }

  const admin = createClient(url, secret, { auth: { persistSession: false } });
  const email = process.env.SMOKE_EMAIL ?? (await onlyUserEmail(admin));

  const link = await admin.auth.admin.generateLink({
    type: "magiclink",
    email,
  });
  if (link.error) throw link.error;

  const anon = createClient(url, publishable, {
    auth: { persistSession: false },
  });
  const verified = await anon.auth.verifyOtp({
    token_hash: link.data.properties.hashed_token,
    type: "magiclink",
  });
  if (verified.error || !verified.data.session) {
    throw verified.error ?? new Error("No session from the magic link");
  }

  const name = `sb-${new URL(url).hostname.split(".")[0]}-auth-token`;
  const value = `base64-${Buffer.from(JSON.stringify(verified.data.session)).toString("base64url")}`;
  const chunks = value.match(new RegExp(`.{1,${COOKIE_CHUNK}}`, "g"))!;

  const cookies = chunks.map((chunk, index) => ({
    name: chunks.length > 1 ? `${name}.${index}` : name,
    value: chunk,
    domain: "localhost",
    path: "/",
    expires: -1,
    httpOnly: false,
    secure: false,
    sameSite: "Lax" as const,
  }));

  mkdirSync(dirname(AUTH_STATE), { recursive: true });
  writeFileSync(
    AUTH_STATE,
    JSON.stringify({
      cookies,
      origins: [
        { origin: `http://localhost:${DASHBOARD_PORT}`, localStorage: [] },
      ],
    }),
  );
  writeFileSync(AUTH_USER, JSON.stringify({ id: verified.data.user!.id }));
}

// The development database has one user; with more, name one in SMOKE_EMAIL.
async function onlyUserEmail(admin: SupabaseClient) {
  const { data, error } = await admin.auth.admin.listUsers({ perPage: 2 });
  if (error) throw error;

  const [user, other] = data.users;
  if (!user?.email || other) {
    throw new Error(
      "Set SMOKE_EMAIL: the database does not have exactly one user",
    );
  }

  return user.email;
}
