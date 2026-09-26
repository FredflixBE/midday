import { OTLPLogExporter } from "@opentelemetry/exporter-logs-otlp-http";

/**
 * Where task logs go besides the Trigger.dev run view: a Better Stack source
 * created with the OpenTelemetry platform, when its token and ingesting host
 * are set in the Trigger.dev environment. Unset, nothing is exported.
 *
 * These are not the API's `BETTER_STACK_SOURCE_TOKEN` and
 * `BETTER_STACK_INGESTING_HOST`: those send `@midday/logger` lines in Better
 * Stack's own format, and an OpenTelemetry source is a different source.
 * `trigger.config.ts` calls this, and the task worker evaluates that file
 * with the environment's variables, so the Trigger.dev dashboard is where
 * these are set.
 */
export function betterStackLogExporters(
  env: Record<string, string | undefined>,
): OTLPLogExporter[] {
  const sourceToken = env.BETTER_STACK_JOBS_SOURCE_TOKEN?.trim();
  const host = env.BETTER_STACK_JOBS_INGESTING_HOST?.trim();
  if (!sourceToken || !host) return [];

  // Better Stack shows the host without a scheme; one is accepted anyway so a
  // test can point at plain http.
  const origin = /^https?:\/\//.test(host) ? host : `https://${host}`;

  return [
    new OTLPLogExporter({
      url: `${origin}/v1/logs`,
      headers: { Authorization: `Bearer ${sourceToken}` },
    }),
  ];
}
