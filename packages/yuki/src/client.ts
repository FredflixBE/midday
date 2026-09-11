import { baseUrlFor, type YukiConfig } from "./config";
import {
  YukiConfigError,
  YukiOperationNotAllowedError,
  YukiRequestError,
} from "./errors";
import {
  isKnownWriteOperation,
  isReadOperation,
  serviceFor,
  type WriteOperation,
  type YukiService,
} from "./operations";
import {
  buildEnvelope,
  faultStringFrom,
  type SoapParams,
  soapActionFor,
  unwrapResult,
} from "./soap";

/**
 * Only what the client actually uses. Narrower than `typeof fetch`, which also
 * carries `preconnect` and is awkward to substitute in a test.
 */
export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export interface YukiClientConfig extends YukiConfig {
  /**
   * Writes that this particular client is permitted to issue, by name.
   *
   * Defaults to none. Yuki has no delete operation anywhere and no sandbox, so
   * a write cannot be taken back — a caller that needs one names it here, and
   * gets only that one.
   */
  allowWriteOperations?: readonly WriteOperation[];
  /** Milliseconds before a single request is abandoned. Default 30_000. */
  timeoutMs?: number;
  fetchImpl?: FetchLike;
}

export interface YukiCallOptions {
  /** Omit the sessionID parameter, for Authenticate itself. */
  withoutSession?: boolean;
  /** Override the service, for operations exposed on more than one. */
  service?: YukiService;
}

export class YukiClient {
  readonly #config: YukiClientConfig;
  readonly #allowedWrites: ReadonlySet<string>;
  readonly #fetch: FetchLike;
  #sessionId: string | undefined;

  constructor(config: YukiClientConfig) {
    this.#config = config;
    this.#allowedWrites = new Set(config.allowWriteOperations ?? []);
    this.#fetch = config.fetchImpl ?? fetch;
  }

  /**
   * Throws unless the operation is a known read, or a write this client was
   * explicitly constructed to permit. Unknown operations fail closed: an
   * operation nobody has classified might be a write.
   */
  assertAllowed(operation: string): void {
    if (isReadOperation(operation)) return;

    if (isKnownWriteOperation(operation)) {
      if (this.#allowedWrites.has(operation)) return;
      throw new YukiOperationNotAllowedError(
        operation,
        "it changes state in Yuki, and this client was not constructed with it in allowWriteOperations. Yuki has no delete operation, so a write cannot be undone.",
      );
    }

    throw new YukiOperationNotAllowedError(
      operation,
      "it is not in the read allowlist. If it is a read, add it to READ_OPERATIONS; if it writes, add it to WRITE_OPERATIONS so it is refused for the right reason.",
    );
  }

  /** Exchanges the access key for a session id. Cached for the client's life. */
  async authenticate(): Promise<string> {
    if (this.#sessionId) return this.#sessionId;

    const result = await this.call(
      "Authenticate",
      { accessKey: this.#config.accessKey },
      { withoutSession: true },
    );

    const sessionId = typeof result === "string" ? result.trim() : "";
    if (!sessionId) {
      throw new YukiRequestError({
        operation: "Authenticate",
        message: "Authenticate returned no session id. Check the access key.",
      });
    }

    this.#sessionId = sessionId;
    return sessionId;
  }

  /**
   * Issues one operation. `sessionID` is prepended unless suppressed, because
   * ASMX validates parameters as an ordered sequence and Yuki always takes the
   * session first.
   */
  async call(
    operation: string,
    params: SoapParams = {},
    options: YukiCallOptions = {},
  ): Promise<unknown> {
    this.assertAllowed(operation);

    const service = options.service ?? serviceFor(operation);
    if (!service) {
      throw new YukiOperationNotAllowedError(
        operation,
        "no service is registered for it.",
      );
    }

    const body = buildEnvelope(
      operation,
      options.withoutSession
        ? params
        : { sessionID: await this.authenticate(), ...params },
    );

    const url = `${baseUrlFor(this.#config.region)}/${service}.asmx`;
    const response = await this.#fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "text/xml; charset=utf-8",
        SOAPAction: soapActionFor(operation),
      },
      body,
      signal: AbortSignal.timeout(this.#config.timeoutMs ?? 30_000),
    });

    const text = await response.text();

    const fault = faultStringFrom(text);
    if (fault) {
      throw new YukiRequestError({
        operation,
        message: `${operation} faulted: ${fault}`,
        status: response.status,
        faultString: fault,
      });
    }

    if (!response.ok) {
      throw new YukiRequestError({
        operation,
        message: `${operation} failed with HTTP ${response.status}`,
        status: response.status,
      });
    }

    return unwrapResult(text, operation);
  }

  /**
   * Throws with a usable message rather than sending an empty parameter, which
   * Yuki answers with an opaque fault.
   */
  get administrationId(): string {
    const id = this.#config.administrationId;
    if (!id) {
      throw new YukiConfigError(
        "YUKI_ADMINISTRATION_ID is not set. Run the explore script and read it from the 01-administrations probe, then add it to packages/yuki/.env.",
      );
    }
    return id;
  }
}
