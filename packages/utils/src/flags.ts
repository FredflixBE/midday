const OFF_VALUES = new Set(["false", "0", "no", "off"]);

type FlagOptions = {
  /** What an unset or empty variable means. Defaults to on. */
  defaultValue?: boolean;
};

/**
 * Reads a boolean feature flag from the environment.
 *
 * Unset and empty values fall back to `defaultValue` (on unless stated
 * otherwise); `false`, `0`, `no` and `off` (any case) turn the flag off; any
 * other value turns it on. Used for the scheduled jobs that previously only
 * ran in Midday's own production environment.
 */
export function isFlagEnabled(
  name: string,
  { defaultValue = true }: FlagOptions = {},
): boolean {
  const raw = process.env[name]?.trim().toLowerCase();

  if (!raw) {
    return defaultValue;
  }

  return !OFF_VALUES.has(raw);
}
