import { defineConfig, devices } from "@playwright/test";
import {
  API_PORT,
  API_URL,
  AUTH_STATE,
  DASHBOARD_PORT,
  DASHBOARD_URL,
} from "./e2e/env";

/**
 * A smoke suite for the UI primitives (FF-1773): one test per component
 * family, so replacing the primitives underneath (FF-1772) can be checked
 * against what each one did before.
 *
 * `bun run test:smoke` starts an API and a dashboard on 3103/3101 (or reuses
 * ones already listening there), signs in and runs every spec.
 */
export default defineConfig({
  testDir: "./e2e",
  globalSetup: "./e2e/global-setup.ts",
  // One signed-in user and one shared database: run the specs one at a time.
  workers: 1,
  fullyParallel: false,
  // The first visit to a route compiles it in `next dev`.
  timeout: 120_000,
  expect: { timeout: 15_000 },
  reporter: [["list"]],
  use: {
    ...devices["Desktop Chrome"],
    baseURL: DASHBOARD_URL,
    storageState: AUTH_STATE,
    viewport: { width: 1440, height: 900 },
    navigationTimeout: 90_000,
    trace: "retain-on-failure",
  },
  webServer: [
    {
      name: "api",
      cwd: "../api",
      command: "bun run src/index.ts",
      url: `${API_URL}/health`,
      reuseExistingServer: true,
      timeout: 120_000,
      env: {
        TZ: "UTC",
        PORT: String(API_PORT),
        API_URL,
        MIDDAY_API_URL: API_URL,
        DASHBOARD_URL,
        MIDDAY_DASHBOARD_URL: DASHBOARD_URL,
        ALLOWED_API_ORIGINS: DASHBOARD_URL,
      },
    },
    {
      name: "dashboard",
      command: `bunx next dev -p ${DASHBOARD_PORT} --turbopack`,
      url: `${DASHBOARD_URL}/login`,
      reuseExistingServer: true,
      timeout: 180_000,
      env: {
        TZ: "UTC",
        NEXT_PUBLIC_URL: DASHBOARD_URL,
        NEXT_PUBLIC_API_URL: API_URL,
        // Server-side prefetches use this one, and the copied .env points it
        // at the API on 3003.
        API_INTERNAL_URL: API_URL,
      },
    },
  ],
});
