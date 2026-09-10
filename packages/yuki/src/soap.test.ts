import { describe, expect, it } from "bun:test";
import { baseUrlFor } from "./config";
import {
  buildEnvelope,
  escapeXml,
  faultStringFrom,
  soapActionFor,
  unwrapResult,
  YUKI_NAMESPACE,
} from "./soap";

describe("envelope", () => {
  it("matches the shape Yuki publishes for Authenticate", () => {
    const xml = buildEnvelope("Authenticate", { accessKey: "abc" });
    expect(xml).toContain(`<Authenticate xmlns="${YUKI_NAMESPACE}">`);
    expect(xml).toContain("<accessKey>abc</accessKey>");
    expect(xml).toContain(
      'xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"',
    );
  });

  it("keeps parameters in the order given, because ASMX validates a sequence", () => {
    const xml = buildEnvelope("GLAccountTransactions", {
      sessionID: "s",
      administrationID: "a",
      GLAccountCode: "550000",
    });
    expect(xml.indexOf("<sessionID>")).toBeLessThan(
      xml.indexOf("<administrationID>"),
    );
    expect(xml.indexOf("<administrationID>")).toBeLessThan(
      xml.indexOf("<GLAccountCode>"),
    );
  });

  it("omits undefined and null parameters rather than sending empty elements", () => {
    const xml = buildEnvelope("Documents", {
      sessionID: "s",
      folderId: undefined,
      tabId: null,
    });
    expect(xml).not.toContain("folderId");
    expect(xml).not.toContain("tabId");
  });

  it("escapes values that would otherwise break the document", () => {
    expect(escapeXml(`a & b < c > d " e ' f`)).toBe(
      "a &amp; b &lt; c &gt; d &quot; e &apos; f",
    );
    const xml = buildEnvelope("SearchDocuments", { searchText: "R&D <test>" });
    expect(xml).toContain("<searchText>R&amp;D &lt;test&gt;</searchText>");
  });

  it("quotes the SOAPAction header", () => {
    expect(soapActionFor("FindDocument")).toBe(
      `"${YUKI_NAMESPACE}FindDocument"`,
    );
  });
});

describe("response handling", () => {
  const ok = `<?xml version="1.0" encoding="utf-8"?>
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
  <soap:Body>
    <AuthenticateResponse xmlns="http://www.theyukicompany.com/">
      <AuthenticateResult>session-123</AuthenticateResult>
    </AuthenticateResponse>
  </soap:Body>
</soap:Envelope>`;

  it("unwraps Envelope > Body > {Op}Response > {Op}Result", () => {
    expect(unwrapResult(ok, "Authenticate")).toBe("session-123");
  });

  it("returns undefined when the operation does not match the response", () => {
    expect(unwrapResult(ok, "FindDocument")).toBeUndefined();
  });

  it("surfaces a SOAP fault string", () => {
    const fault = `<?xml version="1.0" encoding="utf-8"?>
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
  <soap:Body>
    <soap:Fault>
      <faultcode>soap:Server</faultcode>
      <faultstring>Domain has no active database</faultstring>
    </soap:Fault>
  </soap:Body>
</soap:Envelope>`;
    expect(faultStringFrom(fault)).toBe("Domain has no active database");
  });

  it("reports no fault for a healthy response", () => {
    expect(faultStringFrom(ok)).toBeUndefined();
  });
});

describe("region", () => {
  it("routes Belgian domains to the .be host", () => {
    expect(baseUrlFor("be")).toBe("https://api.yukiworks.be/ws");
    expect(baseUrlFor("nl")).toBe("https://api.yukiworks.nl/ws");
  });
});
