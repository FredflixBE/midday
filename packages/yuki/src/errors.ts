/** Raised when the allowlist refuses an operation. Never reaches the network. */
export class YukiOperationNotAllowedError extends Error {
  readonly operation: string;

  constructor(operation: string, reason: string) {
    super(`Refused to call "${operation}": ${reason}`);
    this.name = "YukiOperationNotAllowedError";
    this.operation = operation;
  }
}

/** A SOAP fault, or a non-2xx response, from Yuki. */
export class YukiRequestError extends Error {
  readonly operation: string;
  readonly status?: number;
  readonly faultString?: string;

  constructor(params: {
    operation: string;
    message: string;
    status?: number;
    faultString?: string;
  }) {
    super(params.message);
    this.name = "YukiRequestError";
    this.operation = params.operation;
    this.status = params.status;
    this.faultString = params.faultString;
  }
}

/**
 * Whether Yuki refused because the domain's allowance for the day is spent.
 *
 * Yuki allows 1,000 calls a day per domain on the free tier and then faults
 * every operation with `Daily limit exceeded` until midnight. Measured on
 * 2026-09-12, pulling 200 purchase invoices: a document is one call each, on
 * top of the fifteen an archive read costs, and the day's other jobs.
 *
 * It is worth telling apart from every other fault because it is not a failure
 * of anything — nothing is wrong, nothing is lost, and the answer is to run the
 * job again tomorrow. A caller that treats it as an error reports a broken
 * integration to somebody whose integration is fine.
 */
export function isYukiDailyLimit(error: unknown): boolean {
  return (
    error instanceof YukiRequestError &&
    /daily limit exceeded/i.test(error.message)
  );
}

/** Missing or malformed configuration. */
export class YukiConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "YukiConfigError";
  }
}

export type YukiAccessRefusal =
  | "key_refused"
  | "wrong_region"
  | "no_administration"
  | "unknown_administration";

const REFUSAL_MESSAGES: Record<YukiAccessRefusal, string> = {
  key_refused:
    "Yuki did not accept this access key. Copy it again from Settings > Web services in Yuki.",
  wrong_region:
    "This key works, but its books are not on this region's servers. Try the other region.",
  no_administration: "This access key cannot see any administration in Yuki.",
  unknown_administration:
    "This access key cannot see the chosen administration. Check the key again and pick one it lists.",
};

/** The key, region or domain cannot be used; the message is for the user. */
export class YukiAccessError extends Error {
  readonly reason: YukiAccessRefusal;

  constructor(reason: YukiAccessRefusal) {
    super(REFUSAL_MESSAGES[reason]);
    this.name = "YukiAccessError";
    this.reason = reason;
  }
}

/**
 * The archive was asked about a reference with nothing comparable in it.
 *
 * This throws rather than answering "no invoice has that number", because the
 * two are not the same answer and the caller acts on them differently. "Yuki
 * does not hold this" means *deliver the invoice*, and Yuki has no delete
 * operation — so an empty or punctuation-only number quietly taking that path
 * is a permanent duplicate in live books.
 *
 * A caller that may hold an unusable number checks it with
 * `comparableInvoiceReference` first; FF-1493's rule 1 already routes one to
 * Needs attention before Yuki is asked at all.
 */
export class YukiReferenceError extends Error {
  readonly reference: string;

  constructor(reference: string) {
    super(
      `Cannot look up "${reference}": it has no letter or digit in it, so there is nothing to compare. This is not the same as Yuki not holding it — check comparableInvoiceReference before asking.`,
    );
    this.name = "YukiReferenceError";
    this.reference = reference;
  }
}

/** Raised for a team with no Yuki app. A job should skip that team, not fail. */
export class YukiNotConnectedError extends Error {
  readonly teamId: string;

  constructor(teamId: string) {
    super(`Team ${teamId} has not connected Yuki.`);
    this.name = "YukiNotConnectedError";
    this.teamId = teamId;
  }
}
