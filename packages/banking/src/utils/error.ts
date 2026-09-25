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

  // A ProviderError made from an HTTP error keeps the original as its cause.
  const e = (
    error instanceof ProviderError && error.cause ? error.cause : error
  ) as {
    response?: { status?: number; data?: unknown };
  } | null;

  if (error instanceof ProviderError) {
    details.providerCode = error.code;
  }

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

  constructor({
    message,
    code,
    cause,
  }: {
    message: string;
    code: string;
    cause?: unknown;
  }) {
    super(message, { cause });
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

      // EnableBanking: the bank behind it (the ASPSP) refused or failed —
      // anything from its PSD2 API saying no to its CDN blocking the request.
      // Not ours to fix, and asking again straight away spends another of the
      // account's unattended reads.
      case "ASPSP_ERROR":
        logger.warn("Bank refused the request", { message: this.message });
        return "bank_error";

      default:
        logger.warn("Unknown provider error", { code, message: this.message });
        return "unknown";
    }
  }
}

/**
 * An HTTP error carrying Enable Banking's error reply, as a ProviderError that
 * says what Enable Banking said — its status, code, message and detail — so the
 * code reaches the job named rather than as "unknown". Anything else (a network
 * failure, a reply with no error code) is returned unchanged.
 */
export function fromEnableBankingError(error: unknown): unknown {
  const response = (
    error as {
      response?: {
        status?: number;
        data?: { error?: unknown; message?: unknown; detail?: unknown };
      };
    } | null
  )?.response;
  const data = response?.data;

  if (typeof data?.error !== "string") {
    return error;
  }

  const said = typeof data.message === "string" ? data.message : "no message";
  const detail = typeof data.detail === "string" ? ` (${data.detail})` : "";

  return new ProviderError({
    message: `Enable Banking ${response?.status ?? "error"} ${data.error}: ${said}${detail}`,
    code: data.error,
    cause: error,
  });
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
