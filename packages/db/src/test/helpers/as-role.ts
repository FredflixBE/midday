/**
 * Run a query as the database role and JWT claims a request would carry.
 *
 * Every RLS assertion needs this, and it is easy to get subtly wrong: the
 * policies read auth.uid() (which reads request.jwt.claim.sub) *and*
 * auth.jwt() (which reads request.jwt.claims), so a helper that sets only one
 * of them passes the tests that happen not to use the other.
 *
 * Always inside a transaction that is rolled back, because `set local role`
 * only lasts that long — and because a test that leaves rows behind poisons
 * the next one.
 */
import type { Client } from "pg";

export type TestUser = {
  id: string;
  email?: string;
};

/** Pass no user to act as `anon`, the role a signed-out browser gets. */
export async function asRole<T>(
  client: Client,
  user: TestUser | null,
  fn: () => Promise<T>,
): Promise<T> {
  await client.query("begin");

  try {
    await client.query(
      user ? "set local role authenticated" : "set local role anon",
    );

    if (user) {
      await client.query(
        "select set_config('request.jwt.claim.sub', $1, true)",
        [user.id],
      );
      await client.query("select set_config('request.jwt.claims', $1, true)", [
        JSON.stringify({ sub: user.id, email: user.email ?? null }),
      ]);
    }

    return await fn();
  } finally {
    await client.query("rollback");
  }
}
