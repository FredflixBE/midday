import { describe, expect, it } from "bun:test";
import { YukiClient } from "./client";
import { YukiOperationNotAllowedError } from "./errors";
import {
  isKnownWriteOperation,
  isReadOperation,
  READ_OPERATIONS,
  serviceFor,
  WRITE_OPERATION_SERVICES,
  WRITE_OPERATIONS,
} from "./operations";

const config = {
  accessKey: "test-key",
  administrationId: "test-admin",
  region: "be",
} as const;

function clientThatMustNotFetch(
  allowWriteOperations?: readonly (typeof WRITE_OPERATIONS)[number][],
) {
  return new YukiClient({
    ...config,
    allowWriteOperations,
    fetchImpl: () => {
      throw new Error("the network must not be reached");
    },
  });
}

describe("the allowlist", () => {
  it("permits every registered read", () => {
    const client = clientThatMustNotFetch();
    for (const operation of Object.keys(READ_OPERATIONS)) {
      expect(() => client.assertAllowed(operation)).not.toThrow();
    }
  });

  it("refuses every known write by default", () => {
    const client = clientThatMustNotFetch();
    for (const operation of WRITE_OPERATIONS) {
      expect(() => client.assertAllowed(operation)).toThrow(
        YukiOperationNotAllowedError,
      );
    }
  });

  it("fails closed on an operation nobody has classified", () => {
    const client = clientThatMustNotFetch();
    expect(() => client.assertAllowed("SomeFutureOperation")).toThrow(
      YukiOperationNotAllowedError,
    );
  });

  it("permits a write only when that exact write was opted into", () => {
    const client = clientThatMustNotFetch(["UploadDocument"]);
    expect(() => client.assertAllowed("UploadDocument")).not.toThrow();
    expect(() => client.assertAllowed("UploadDocumentWithData")).toThrow(
      YukiOperationNotAllowedError,
    );
    expect(() => client.assertAllowed("ProcessSalesInvoices")).toThrow(
      YukiOperationNotAllowedError,
    );
  });

  it("never reaches the network for a refused operation", async () => {
    const client = clientThatMustNotFetch();
    await expect(client.call("ProcessJournal", {})).rejects.toThrow(
      YukiOperationNotAllowedError,
    );
  });

  it("says why a write is refused, not merely that it is", () => {
    const client = clientThatMustNotFetch();
    expect(() => client.assertAllowed("UploadDocument")).toThrow(
      /no delete operation/,
    );
  });

  it("classifies reads and writes disjointly", () => {
    for (const operation of WRITE_OPERATIONS) {
      expect(isReadOperation(operation)).toBe(false);
      expect(isKnownWriteOperation(operation)).toBe(true);
    }
  });

  it("knows a hosting service for every classified operation", () => {
    for (const operation of Object.keys(READ_OPERATIONS)) {
      expect(serviceFor(operation)).toBeDefined();
    }
    for (const operation of WRITE_OPERATIONS) {
      expect(WRITE_OPERATION_SERVICES[operation]).toBeDefined();
    }
  });
});
