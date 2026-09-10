import { XMLParser } from "fast-xml-parser";

/**
 * Yuki's services are classic ASMX endpoints speaking SOAP 1.1. The envelope
 * and namespace below were read off the published operation pages, e.g.
 * https://api.yukiworks.be/ws/Archive.asmx?op=Authenticate
 */
export const YUKI_NAMESPACE = "http://www.theyukicompany.com/";

export type SoapParams = Record<
  string,
  string | number | boolean | null | undefined
>;

const XML_ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&apos;",
};

export function escapeXml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => XML_ESCAPES[c] as string);
}

/**
 * Parameters are emitted in the order given. ASMX validates against a sequence,
 * so order matters — an out-of-order parameter is rejected even when every name
 * is correct.
 */
export function buildEnvelope(operation: string, params: SoapParams): string {
  const body = Object.entries(params)
    .filter(([, value]) => value !== undefined && value !== null)
    .map(([name, value]) => {
      const rendered =
        typeof value === "boolean" ? String(value) : escapeXml(String(value));
      return `      <${name}>${rendered}</${name}>`;
    })
    .join("\n");

  return `<?xml version="1.0" encoding="utf-8"?>
<soap:Envelope xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
  <soap:Body>
    <${operation} xmlns="${YUKI_NAMESPACE}">
${body}
    </${operation}>
  </soap:Body>
</soap:Envelope>`;
}

export function soapActionFor(operation: string): string {
  return `"${YUKI_NAMESPACE}${operation}"`;
}

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@",
  parseTagValue: false,
  trimValues: true,
  removeNSPrefix: true,
});

/** A SOAP fault, if the response carries one. */
export function faultStringFrom(responseXml: string): string | undefined {
  if (!responseXml.includes("Fault")) return undefined;
  try {
    const parsed = parser.parse(responseXml);
    const fault = parsed?.Envelope?.Body?.Fault;
    if (!fault) return undefined;
    return String(
      fault.faultstring ?? fault.faultString ?? "Unknown SOAP fault",
    );
  } catch {
    return undefined;
  }
}

/**
 * Unwraps <Envelope><Body><{Op}Response><{Op}Result>…
 *
 * Several Yuki operations return a *string* containing further XML rather than
 * nested elements. Those come back here as a string; call `parseXml` on the
 * result to go a level deeper.
 */
export function unwrapResult(responseXml: string, operation: string): unknown {
  const parsed = parser.parse(responseXml);
  const body = parsed?.Envelope?.Body;
  if (!body) return undefined;

  const response = body[`${operation}Response`];
  if (response === undefined) return undefined;

  const result = response[`${operation}Result`];
  return result === undefined ? response : result;
}

/** Parse a bare XML document, for results returned as an XML string. */
export function parseXml(xml: string): unknown {
  return parser.parse(xml);
}
