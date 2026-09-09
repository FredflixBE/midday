import { logger } from "./logger";

/**
 * Extract useful error details from provider HTTP errors (xior/axios).
 * Includes status code and response body when available.
 */
export function getProviderErrorDetails(
  error: unknown,
): Record<string, unknown> {
  const details: Record<string, unknown> = {
    error: error instanceof Error ? error.message : String(error),
  };

  const e = error as {
    response?: { status?: number; data?: unknown };
  } | null;

  if (e?.response?.status) {
    details.status = e.response.status;
  }
  if (e?.response?.data) {
    details.providerError = e.response.data;
  }

  return details;
}

export class ProviderError extends Error {
  code: string;

  constructor({ message, code }: { message: string; code: string }) {
    super(message);
    this.code = this.setCode(code);
  }

  setCode(code: string) {
    // GoCardLess
    if (this.message.startsWith("EUA was valid for")) {
      return "disconnected";
    }

    switch (code) {
      // GoCardLess
      case "AccessExpiredError":
      case "AccountInactiveError":
      case "Account suspended":
        logger.warn("Provider disconnected", { code, message: this.message });
        return "disconnected";

      // EnableBanking
      case "ALREADY_AUTHORIZED":
        return "already_authorized";

      default:
        logger.warn("Unknown provider error", { code, message: this.message });
        return "unknown";
    }
  }
}

export function createErrorResponse(error: unknown) {
  logger.error("Provider error response", {
    error: error instanceof Error ? error.message : String(error),
  });

  if (error instanceof ProviderError) {
    return {
      message: error.message,
      code: error.code,
    };
  }

  return {
    message: String(error),
    code: "unknown",
  };
}
