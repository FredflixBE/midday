import { tryGetApiUrl } from "@midday/utils/envs";

/**
 * The MCP endpoint an AI client should be pointed at.
 *
 * These configs are setup copy: every one of them used to hardcode
 * https://api.midday.ai/mcp, which sends a self-hoster's client at Midday's
 * API. The fallback is the local development port rather than a throw,
 * because a wrong instruction is recoverable and a blank app store is not.
 */
export function getMcpServerUrl(): string {
  return `${tryGetApiUrl() ?? "http://localhost:3003"}/mcp`;
}
