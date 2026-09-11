import { type FetchLike, YukiClient } from "./client";
import type { YukiRegion } from "./config";
import { YukiAccessError, YukiRequestError } from "./errors";

export interface YukiAdministration {
  id: string;
  name: string;
  vatNumber?: string;
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
