/**
 * Applies the RLS policies from schema.ts to a database, replacing whatever
 * `drizzle-kit push` left there — push creates every policy without its
 * expression, so this is what makes them grant anything at all. See
 * ./policies.ts for why.
 *
 * Used by the bootstrap script and, so the test database is built the way a
 * real project is, by `test:e2e:setup`:
 *   bun run src/scripts/apply-policies.ts
 */
import { Client } from "pg";
import { resolveTestConnection, sslFor } from "./apply-sql";
import { policyStatements } from "./policies";

/** Returns how many policies were applied. */
export async function applyPolicies(client: Client): Promise<number> {
  const { enableRls, policies } = policyStatements();

  for (const statement of enableRls) {
    await client.query(statement);
  }

  for (const policy of policies) {
    await client.query(policy.drop);
    await client.query(policy.create);
  }

  return policies.length;
}

if (require.main === module) {
  const url = resolveTestConnection();

  const client = new Client({ connectionString: url, ssl: sslFor(url) });

  client
    .connect()
    .then(() => applyPolicies(client))
    .then((count) => console.log(`applied ${count} policies`))
    .catch((error) => {
      console.error(error);
      process.exitCode = 1;
    })
    .finally(() => client.end());
}
