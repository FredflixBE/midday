import { type FetchLike, YukiClient } from "./client";
import type { YukiRegion } from "./config";
import { YukiRequestError } from "./errors";

export interface YukiAdministration {
  id: string;
  name: string;
  vatNumber?: string;
}

export type YukiAccessRefusal =
  | "key_refused"
  | "wrong_region"
  | "no_administration"
  | "unknown_administration";

const REFUSAL_MESSAGES: Record<YukiAccessRefusal, string> = {
  key_refused:
    "Yuki did not accept this access key. Copy it again from Settings > Web services in Yuki.",
  wrong_region:
    "This key works, but its books are not on this region's servers. Try the other region.",
  no_administration: "This access key cannot see any administration in Yuki.",
  unknown_administration:
    "This access key cannot see the chosen administration. Check the key again and pick one it lists.",
};

/** The key, region or domain cannot be used; the message is for the user. */
export class YukiAccessError extends Error {
  readonly reason: YukiAccessRefusal;

  constructor(reason: YukiAccessRefusal) {
    super(REFUSAL_MESSAGES[reason]);
    this.name = "YukiAccessError";
    this.reason = reason;
  }
}

function asArray<T>(value: T | T[] | undefined): T[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

function faultIs(error: unknown, faultString: string): boolean {
  return error instanceof YukiRequestError && error.faultString === faultString;
}

/**
 * Proves an access key before anything is stored, using reads only.
 *
 * Authenticate and Administrations alone let a wrong region through: measured
 * on 2026-09-11, a Belgian key does both on the Dutch host. Only a read of the
 * books themselves fails there, so one more read is made, of the folder list,
 * which is small and needs no administration.
 */
export async function verifyAccess(
  credentials: { accessKey: string; region: YukiRegion },
  options: { fetchImpl?: FetchLike } = {},
): Promise<{ administrations: YukiAdministration[] }> {
  const client = new YukiClient({ ...credentials, ...options });

  try {
    await client.authenticate();
  } catch (error) {
    if (faultIs(error, "Invalid access key")) {
      throw new YukiAccessError("key_refused");
    }
    throw error;
  }

  const result = (await client.call("Administrations")) as {
    Administrations?: { Administration?: unknown };
  } | null;

  // One administration parses as an object and several as an array.
  const administrations = asArray(
    result?.Administrations?.Administration as
      | Record<string, string>
      | Record<string, string>[]
      | undefined,
  ).map((a) => ({
    id: a["@ID"] as string,
    name: a.Name ?? "",
    ...(a.VATNumber ? { vatNumber: a.VATNumber } : {}),
  }));

  if (administrations.length === 0) {
    throw new YukiAccessError("no_administration");
  }

  try {
    await client.call("DocumentFolders");
  } catch (error) {
    if (faultIs(error, "Domain has no active database")) {
      throw new YukiAccessError("wrong_region");
    }
    throw error;
  }

  return { administrations };
}
