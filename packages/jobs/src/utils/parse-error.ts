export type ParsedAPIError = { code: string; message: string };

export function parseAPIError(error: unknown): ParsedAPIError {
  if (typeof error === "object" && error !== null && "error" in error) {
    const apiError = error as { error: { code: string; message: string } };

    return {
      code: apiError.error.code,
      message: apiError.error.message,
    };
  }

  // Handle TRPCClientError shape where providerCode is embedded in the message
  if (typeof error === "object" && error !== null && "message" in error) {
    const message = (error as { message: string }).message;

    try {
      const parsed = JSON.parse(message);
      if (parsed.providerCode) {
        const failed = parsed.message ?? message;
        return {
          code: parsed.providerCode,
          // What the provider said, when the API passed it on.
          message: parsed.providerMessage
            ? `${failed}: ${parsed.providerMessage}`
            : failed,
        };
      }
    } catch {
      // Not JSON, fall through
    }
  }

  return { code: "unknown", message: "An unknown error occurred" };
}

/**
 * The bank behind the provider refused. Asking again straight away spends
 * another of the account's few unattended reads a day and, when the refusal is
 * the bank's CDN blocking traffic, tends to prolong the block — so a job stops
 * rather than retrying, and the next scheduled sync tries again.
 */
export function isBankRefusal(error: ParsedAPIError) {
  return error.code === "bank_error";
}
