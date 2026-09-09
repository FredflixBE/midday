/**
 * The tables in the `supabase_realtime` publication.
 *
 * `supabase/20-realtime.sql` is what puts them there and is the source of
 * truth; this mirrors it so the bootstrap's check and the tests do not each
 * keep their own list. A test asserts the two agree, so the mirror cannot
 * drift silently.
 */
export const PUBLISHED_TABLES = [
  "activities",
  "customers",
  "documents",
  "inbox",
  "insights",
  "transactions",
] as const;
