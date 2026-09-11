import { describe, expect, it } from "bun:test";
import { verifyAccess } from "./access";
import type { FetchLike } from "./client";
import { YukiAccessError } from "./errors";
import { YUKI_NAMESPACE } from "./soap";

type Answer = { result: string } | { fault: string };

/**
 * Plays Yuki's side of the conversation: one canned answer per operation,
 * read off the SOAPAction header. Records what was asked, and where.
 */
function fakeYuki(answers: Record<string, Answer>) {
  const calls: { operation: string; url: string }[] = [];

  const fetchImpl: FetchLike = async (url, init) => {
    const action = String(
      (init.headers as Record<string, string>).SOAPAction,
    ).replace(/"/g, "");
    const operation = action.slice(YUKI_NAMESPACE.length);
    calls.push({ operation, url });

    const answer = answers[operation];
    if (!answer) throw new Error(`no canned answer for ${operation}`);

    if ("fault" in answer) {
      return new Response(
        `<?xml version="1.0" encoding="utf-8"?>
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
  <soap:Body><soap:Fault><faultcode>soap:Server</faultcode><faultstring>${answer.fault}</faultstring></soap:Fault></soap:Body>
</soap:Envelope>`,
        { status: 500 },
      );
    }

    return new Response(
      `<?xml version="1.0" encoding="utf-8"?>
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
  <soap:Body>
    <${operation}Response xmlns="${YUKI_NAMESPACE}">
      <${operation}Result>${answer.result}</${operation}Result>
    </${operation}Response>
  </soap:Body>
</soap:Envelope>`,
    );
  };

  return { fetchImpl, calls };
}

const ADMIN_A = "11111111-1111-1111-1111-111111111111";
const ADMIN_B = "22222222-2222-2222-2222-222222222222";

function administration(id: string, name: string, vat: string) {
  return `<Administration ID="${id}"><Name>${name}</Name><VATNumber>${vat}</VATNumber><Active>True</Active></Administration>`;
}

const healthyDomain = (administrations: string): Record<string, Answer> => ({
  Authenticate: { result: "session-1" },
  Administrations: {
    result: `<Administrations>${administrations}</Administrations>`,
  },
  DocumentFolders: { result: "<DocumentFolders />" },
});

describe("verifying an access key", () => {
  it("names the administration the key can read, so the user can confirm the company", async () => {
    const yuki = fakeYuki(
      healthyDomain(administration(ADMIN_A, "Acme BV", "BE0123456789")),
    );

    const { administrations } = await verifyAccess(
      { accessKey: "key", region: "be" },
      { fetchImpl: yuki.fetchImpl },
    );

    expect(administrations).toEqual([
      { id: ADMIN_A, name: "Acme BV", vatNumber: "BE0123456789" },
    ]);
  });

  it("lists every administration when the key sees more than one", async () => {
    const yuki = fakeYuki(
      healthyDomain(
        administration(ADMIN_A, "Acme BV", "BE0123456789") +
          administration(ADMIN_B, "Acme Holding", "BE0987654321"),
      ),
    );

    const { administrations } = await verifyAccess(
      { accessKey: "key", region: "be" },
      { fetchImpl: yuki.fetchImpl },
    );

    expect(administrations.map((a) => a.name)).toEqual([
      "Acme BV",
      "Acme Holding",
    ]);
  });

  it("refuses a key Yuki does not accept, and asks nothing further", async () => {
    const yuki = fakeYuki({
      Authenticate: { fault: "Invalid access key" },
    });

    const attempt = verifyAccess(
      { accessKey: "wrong", region: "be" },
      { fetchImpl: yuki.fetchImpl },
    );

    await expect(attempt).rejects.toBeInstanceOf(YukiAccessError);
    await expect(attempt).rejects.toMatchObject({ reason: "key_refused" });
    expect(yuki.calls.map((c) => c.operation)).toEqual(["Authenticate"]);
  });

  // Measured on 2026-09-11: a Belgian key authenticates on the Dutch host and
  // even lists its administrations there. Only a read of the books themselves
  // fails, so without this a wrong region would be saved and every sync after
  // it would fail instead.
  it("refuses the wrong region, which Authenticate and Administrations both let through", async () => {
    const yuki = fakeYuki({
      ...healthyDomain(administration(ADMIN_A, "Acme BV", "BE0123456789")),
      DocumentFolders: { fault: "Domain has no active database" },
    });

    const attempt = verifyAccess(
      { accessKey: "key", region: "nl" },
      { fetchImpl: yuki.fetchImpl },
    );

    await expect(attempt).rejects.toMatchObject({ reason: "wrong_region" });
    expect(
      yuki.calls.every((c) => c.url.startsWith("https://api.yukiworks.nl/")),
    ).toBe(true);
  });

  it("refuses a key that sees no administration at all", async () => {
    const yuki = fakeYuki(healthyDomain(""));

    await expect(
      verifyAccess(
        { accessKey: "key", region: "be" },
        { fetchImpl: yuki.fetchImpl },
      ),
    ).rejects.toMatchObject({ reason: "no_administration" });
  });
});
