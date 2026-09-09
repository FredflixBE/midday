/**
 * Environment utility functions
 * Centralized logic for checking environment variables
 */

/**
 * Check if the worker is running in staging environment
 */
export function isStaging(): boolean {
  return process.env.WORKER_ENV === "staging";
}

/**
 * Check if the worker is running in a non-production environment
 * Used for debug logging only; scheduled tasks are gated by explicit
 * *_ENABLED flags instead (see @midday/utils/flags).
 */
export function isDevelopment(): boolean {
  return process.env.NODE_ENV !== "production";
}
