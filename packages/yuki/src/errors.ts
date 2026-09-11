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

/** Raised for a team with no Yuki app. A job should skip that team, not fail. */
export class YukiNotConnectedError extends Error {
  readonly teamId: string;

  constructor(teamId: string) {
    super(`Team ${teamId} has not connected Yuki.`);
    this.name = "YukiNotConnectedError";
    this.teamId = teamId;
  }
}
