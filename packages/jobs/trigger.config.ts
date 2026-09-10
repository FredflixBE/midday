import { defineConfig } from "@trigger.dev/sdk";

export default defineConfig({
  // The project ref, literally, the way `trigger init` writes it. It is an
  // identifier rather than a credential — an access token is what grants
  // anything — and keeping it here means the CLI can read it, which it cannot
  // do from .env: it evaluates this file before it loads one.
  project: "proj_sgmczlmqfzditzydebar",
  runtime: "node",
  logLevel: "log",
  maxDuration: 60,
  experimental_processKeepAlive: true,
  retries: {
    enabledInDev: false,
    default: {
      maxAttempts: 3,
      minTimeoutInMs: 1000,
      maxTimeoutInMs: 10000,
      factor: 2,
      randomize: true,
    },
  },
  build: {
    external: ["sharp", "canvas", "pino"],
  },
  dirs: ["./src/tasks"],
});
