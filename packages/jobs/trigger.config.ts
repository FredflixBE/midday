import { defineConfig } from "@trigger.dev/sdk";
import { betterStackLogExporters } from "./src/better-stack-logs";

export default defineConfig({
  // The project ref, literally, the way `trigger init` writes it. It is an
  // identifier rather than a credential — an access token is what grants
  // anything — and keeping it here means the CLI can read it, which it cannot
  // do from .env: it evaluates this file before it loads one.
  project: "proj_sgmczlmqfzditzydebar",
  runtime: "node",
  // Not "log". The SDK's LogLevel type accepts it, but the array it is
  // looked up in is ["none","error","warn","info","debug"] — so indexOf
  // returns -1 and every level guard short-circuits, silently discarding
  // every logger call in every task, errors included. "info" emits
  // everything except debug, which is only the progress-update chatter.
  logLevel: "info",
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
  // Task logs also go to Better Stack when its OpenTelemetry source is set in
  // the Trigger.dev environment. The run worker evaluates this file at run
  // time, so `process.env` here is that environment, not the deploy machine's.
  telemetry: {
    logExporters: betterStackLogExporters(process.env),
  },
  dirs: ["./src/tasks"],
});
