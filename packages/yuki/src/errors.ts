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
