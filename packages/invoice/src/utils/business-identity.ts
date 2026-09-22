import type { EditorDoc } from "../types";

/**
 * The business's own identity (FF-1641), read from the team.
 *
 * Until this existed, every one of these lived in exactly one place:
 * `invoice_templates.from_details`, a single rich-text blob typed into the
 * From box of an invoice. There was no other way in and no way in at all
 * from quotes — so a legal requirement was being met by free text somebody
 * had to remember to type on an unrelated screen.
 *
 * Every field is optional because a team fills this in over time, and a
 * half-filled identity still reads better than an empty From block.
 */
export type BusinessIdentity = {
  /** The registered name. A team's `name` is what it is called on screen. */
  legalName?: string | null;
  /** BV, NV, VOF, and so on (WVV art. 2:20). */
  legalForm?: string | null;
  addressLine1?: string | null;
  addressLine2?: string | null;
  zip?: string | null;
  city?: string | null;
  /**
   * Kept for callers that pass a whole team row, but deliberately not
   * printed: the block would show the raw `BE` beside the customer's
   * `Belgium` in the same header, and the country is not among the things
   * WVV art. 2:20 asks a company to state.
   */
  countryCode?: string | null;
  /** The enterprise number, as the KBO writes it. */
  enterpriseNumber?: string | null;
  /** The court of the company's registered office (RPR). */
  rprCourt?: string | null;
  /** One bank account, which WER art. III.25 asks a trader to state. */
  bankIban?: string | null;
  bankBic?: string | null;
};

const said = (value?: string | null) => value?.trim() || null;

/** Whether anything at all has been filled in. */
export function hasBusinessIdentity(identity: BusinessIdentity): boolean {
  return Object.values(identity).some((value) => said(value) !== null);
}

/**
 * The identity as the From block of a quote or an invoice: one paragraph per
 * line, in the order someone reading the document expects them.
 *
 * It is an `EditorDoc` rather than a string because that is what every From
 * renderer already draws — the PDF, the web view and the editor alike — so
 * an identity drops into the place the free-text blob used to hold without
 * anything downstream learning a second shape.
 *
 * Null when nothing has been said, which is what lets the old blob stay the
 * answer for a team that has not filled this in.
 */
export function businessIdentityDoc(
  identity: BusinessIdentity,
): EditorDoc | null {
  const name = [said(identity.legalName), said(identity.legalForm)]
    .filter(Boolean)
    .join(" ");

  const town = [said(identity.zip), said(identity.city)]
    .filter(Boolean)
    .join(" ");

  const labelled = (label: string, value?: string | null) => {
    const text = said(value);
    return text ? `${label} ${text}` : null;
  };

  /**
   * The number, and the one label the law does ask for (FF-1679).
   *
   * Not "Ondernemingsnummer": the FOD Economie guideline says the law never
   * required that word (FF-1677 dropped it). But it does say a VAT-liable
   * business writes "BTW BE" before its number — and a number that carries
   * the BE country code *is* a VAT identification number; the KBO number
   * itself has none. So a `BE…` number is labelled BTW, and a bare number
   * stays bare. That reads the form the team stored, not the team's tax
   * status, which is FF-1678's to record properly.
   */
  const vatLabelled = (value?: string | null) => {
    const text = said(value);
    if (!text) return null;
    return /^BE\s?\d/i.test(text) ? `BTW ${text}` : text;
  };

  const lines = [
    name || null,
    said(identity.addressLine1),
    said(identity.addressLine2),
    town || null,
    vatLabelled(identity.enterpriseNumber),
    labelled("RPR", identity.rprCourt),
    labelled("IBAN", identity.bankIban),
    labelled("BIC", identity.bankBic),
  ].filter((line): line is string => Boolean(line));

  if (lines.length === 0) return null;

  /**
   * One paragraph, its lines separated by breaks (FF-1677).
   *
   * A paragraph each gave every address line paragraph spacing — 23.1pt
   * against the 19.2pt between two lines of body text, so the block that
   * should be the tightest thing on the page was the loosest. An address is
   * one thing said on several lines, and that is what a break is for.
   */
  return {
    type: "doc",
    content: [
      {
        type: "paragraph",
        content: lines.flatMap((text, i) => [
          ...(i === 0 ? [] : [{ type: "hardBreak" as const }]),
          { type: "text" as const, text },
        ]),
      },
    ],
  };
}
