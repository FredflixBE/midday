import { describe, expect, it } from "bun:test";
import {
  fetchLedgerLines,
  findCardGLAccounts,
  parseCardChargeDescription,
  parseGLAccountScheme,
  parseLedgerLines,
  readCardLedger,
  type YukiGLAccount,
  type YukiLedgerLine,
} from "./card";
import { YukiClient } from "./client";

/**
 * Shaped exactly like the live responses measured on 2026-09-12, with every
 * merchant, amount and id invented — this repository is public.
 */

const SCHEME = {
  GlAccount: [
    {
      code: "434000",
      type: "2",
      subtype: "52",
      isEnabled: "true",
      descripton: "(Reserved for credit card)",
    },
    {
      code: "434001",
      type: "2",
      subtype: "52",
      isEnabled: "true",
      descripton: "Bank Card Example Holder",
    },
    {
      code: "434002",
      type: "2",
      subtype: "52",
      isEnabled: "false",
      descripton: "A card nobody uses any more",
    },
    {
      code: "440000",
      type: "2",
      subtype: "2",
      isEnabled: "true",
      descripton: "Leveranciers",
    },
    {
      code: "550001",
      type: "1",
      subtype: "49",
      isEnabled: "true",
      descripton: "Zichtrekening",
    },
    {
      code: "580000",
      type: "1",
      subtype: "4",
      isEnabled: "true",
      descripton: "Interne overboekingen",
    },
    {
      code: "612100",
      type: "6",
      subtype: "0",
      isEnabled: "true",
      descripton: "Kantoorbenodigdheden",
    },
  ],
};

const scheme = parseGLAccountScheme(SCHEME);

const CARD = "434001";
const STATEMENT = "statement-2026-08";

function line(
  overrides: Partial<YukiLedgerLine> & Pick<YukiLedgerLine, "id" | "hID">,
): YukiLedgerLine {
  return {
    date: "2026-08-16",
    description: "MASTERCARD - Kaartverrichtingen - EXAMPLE SHOP",
    amount: -10,
    glAccountCode: CARD,
    statementId: STATEMENT,
    statementCreated: "2026-08-24T10:00:00",
    bookingCurrency: "EUR",
    ...overrides,
  };
}

/** The two lines of one booking, numbered consecutively. */
function booking(params: {
  hID: number;
  amount: number;
  description: string;
  counterpartAccount: string;
  counterpartId: string;
  contactName?: string;
  statementId?: string;
}): YukiLedgerLine[] {
  const shared = {
    description: params.description,
    statementId: params.statementId ?? STATEMENT,
  };

  return [
    line({
      ...shared,
      id: `card-${params.hID}`,
      hID: params.hID,
      amount: params.amount,
      glAccountCode: CARD,
    }),
    line({
      ...shared,
      id: params.counterpartId,
      hID: params.hID + 1,
      amount: -params.amount,
      glAccountCode: params.counterpartAccount,
      contactName: params.contactName,
    }),
  ];
}

describe("the GL account scheme", () => {
  it("reads Yuki's own misspelling of `descripton`", () => {
    expect(scheme.find((a) => a.code === "440000")).toEqual({
      code: "440000",
      subtype: "2",
      description: "Leveranciers",
      enabled: true,
    } satisfies YukiGLAccount);
  });

  it("offers the cards a team could link, and not the unnamed placeholder", () => {
    // 434000 ships enabled on every Belgian scheme with a parenthesised
    // description, because Yuki has nothing to call it yet. Offering it would
    // let someone link an account that has never held a charge.
    expect(findCardGLAccounts(scheme).map((a) => a.code)).toEqual(["434001"]);
  });

  it("still offers a card whose own name happens to carry brackets", () => {
    // The placeholder is parenthesised *entire*, which is what makes it the
    // scheme's own label. Dropping anything with a bracket in it would make
    // "Mastercard (company)" unlinkable, with no explanation anywhere.
    const named = parseGLAccountScheme({
      GlAccount: [
        {
          code: "434003",
          subtype: "52",
          isEnabled: "true",
          descripton: "Mastercard (company)",
        },
      ],
    });

    expect(findCardGLAccounts(named).map((a) => a.code)).toEqual(["434003"]);
  });

  it("survives a scheme that answers with a single account", () => {
    expect(
      parseGLAccountScheme({ GlAccount: SCHEME.GlAccount[1] }).map(
        (a) => a.code,
      ),
    ).toEqual(["434001"]);
  });
});

describe("a ledger line", () => {
  const raw = {
    Transaction: [
      {
        id: "line-1",
        hID: "13034",
        transactionDate: "2026-04-03T00:00:00",
        description: "MASTERCARD - Kaartverrichtingen - EXAMPLE SHOP",
        amount: "-28.44",
        glAccountCode: "434001",
        contact: { HID: "0" },
        document: {
          HID: "7010",
          created: "2026-04-25T10:37:05.847",
          folderId: { "@nil": "true" },
          "@id": "statement-april",
        },
        documentMatched: { matchDate: { "@nil": "true" } },
        foreignCurrency: {
          amountFC: "-28.44",
          rate: "1.000000",
          currency: "EUR",
        },
      },
    ],
  };

  it("keeps only the date, and reads the statement it was booked from", () => {
    expect(parseLedgerLines(raw)).toEqual([
      {
        id: "line-1",
        hID: 13034,
        date: "2026-04-03",
        description: "MASTERCARD - Kaartverrichtingen - EXAMPLE SHOP",
        amount: -28.44,
        glAccountCode: "434001",
        statementId: "statement-april",
        statementCreated: "2026-04-25T10:37:05.847",
        contactName: undefined,
        bookingCurrency: "EUR",
      },
    ]);
  });

  it("reads a nil field as absent rather than as the object Yuki sends", () => {
    const [parsed] = parseLedgerLines({
      Transaction: {
        ...raw.Transaction[0],
        document: { "@id": "s", created: { "@nil": "true" } },
        contact: { fullName: { "@nil": "true" } },
      },
    });

    expect(parsed?.statementCreated).toBeUndefined();
    expect(parsed?.contactName).toBeUndefined();
  });

  it("asks for the window under the names the published signature uses", async () => {
    // A misspelled parameter is not an error here: Yuki ignores the element
    // and answers with the whole ledger back to 2020, which reads as success.
    // So the request is what has to be checked, not the response.
    let body = "";
    const client = new YukiClient({
      accessKey: "k",
      region: "be",
      administrationId: "admin-1",
      fetchImpl: async (_url, init) => {
        const sent = String(init.body);
        if (sent.includes("<Authenticate")) {
          return new Response(
            "<Envelope><Body><AuthenticateResponse><AuthenticateResult>session-1</AuthenticateResult></AuthenticateResponse></Body></Envelope>",
          );
        }
        body = sent;
        return new Response(
          "<Envelope><Body><GetTransactionsResponse><GetTransactionsResult/></GetTransactionsResponse></Body></Envelope>",
        );
      },
    });

    await fetchLedgerLines(client, { from: "2025-09-01", to: "2026-09-12" });

    expect(body).toContain("<startDate>2025-09-01T00:00:00</startDate>");
    expect(body).toContain("<endDate>2026-09-12T00:00:00</endDate>");
    // Deliberately unfiltered: a charge's counterpart can be on any account,
    // and asking per account is what leaves the two direct-to-cost ones
    // unpaired. A year of a small company's books is one call either way.
    expect(body).not.toContain("<glAccountCode>");
  });
});

describe("a card charge's description", () => {
  it("takes the merchant and collapses the statement's alignment spaces", () => {
    expect(
      parseCardChargeDescription(
        "MASTERCARD - Kaartverrichtingen - EXAMPLE SHOP        DUBLIN 1       CO. - EXAMPLE SHOP        DUBLIN 1       CO.",
      ),
    ).toEqual({ merchant: "EXAMPLE SHOP DUBLIN 1 CO." });
  });

  it("reads the original currency and rate, comma decimals and all", () => {
    expect(
      parseCardChargeDescription(
        "MASTERCARD - Kaartverrichtingen - EXAMPLE INC  NEW YORK  NY - Vreemde valuta: USD -29,00 Wisselkoers: 1,13 - EXAMPLE INC  NEW YORK  NY",
      ),
    ).toEqual({
      merchant: "EXAMPLE INC NEW YORK NY",
      foreign: { currency: "USD", amount: -29, rate: 1.13 },
    });
  });

  it("answers with the whole thing when it is shaped like nothing known", () => {
    expect(parseCardChargeDescription("A hand-typed correction")).toEqual({
      merchant: "A hand-typed correction",
    });
  });
});

describe("reading a card account's ledger", () => {
  const missing = booking({
    hID: 100,
    amount: -21.4,
    description: "MASTERCARD - Kaartverrichtingen - EXAMPLE AI  SAN FRANCISCO",
    counterpartAccount: "440000",
    counterpartId: "supplier-open",
    contactName: "Example AI Inc.",
  });

  const settled = booking({
    hID: 200,
    amount: -55.84,
    description: "MASTERCARD - Kaartverrichtingen - EXAMPLE DESIGN  DUBLIN",
    counterpartAccount: "440000",
    counterpartId: "supplier-settled",
    contactName: "Example Design Ltd.",
  });

  const bookedDirectly = booking({
    hID: 300,
    amount: -39,
    description: "MASTERCARD - Kaartverrichtingen - EXAMPLE MAIL  DUBLIN",
    counterpartAccount: "612100",
    counterpartId: "cost-line",
  });

  const settlement = booking({
    hID: 400,
    amount: 281.93,
    description:
      "MASTERCARD - Betaling - Uitgavenstaat transacties van 24/09 tot 23/10 - DOMICILI",
    counterpartAccount: "580000",
    counterpartId: "transfer-line",
  });

  const read = (lines: YukiLedgerLine[]) =>
    readCardLedger({
      lines,
      cardAccountCode: CARD,
      scheme,
      outstandingItemIds: new Set(["supplier-open"]),
    });

  it("says a charge the books still have no invoice for is missing one", () => {
    const { charges } = read(missing);

    expect(charges).toHaveLength(1);
    expect(charges[0]).toMatchObject({
      id: "card-100",
      status: "invoice_missing",
      merchant: "EXAMPLE AI SAN FRANCISCO",
      contactName: "Example AI Inc.",
      amount: -21.4,
      currency: "EUR",
      statementId: STATEMENT,
    });
  });

  it("says a charge that is no longer outstanding is in the books", () => {
    const [charge] = read(settled).charges;

    expect(charge).toMatchObject({ status: "in_the_books" });
    expect(charge?.attentionReason).toBeUndefined();
  });

  it("says a charge booked straight to a cost account is in the books", () => {
    // Two of the 147 measured charges were booked this way, with no supplier
    // line at all. Pairing only against the supplier account would call both
    // of them Needs attention, and send someone to look at nothing.
    expect(read(bookedDirectly).charges[0]).toMatchObject({
      status: "in_the_books",
    });
  });

  it("keeps the monthly settlement out of the charges", () => {
    // It is the card balance being paid off, and the same movement is already
    // in Midday from the current account. Importing it counts it twice.
    const ledger = read(settlement);

    expect(ledger.charges).toEqual([]);
    expect(ledger.undecidedCredits).toEqual([]);
    expect(ledger.settlements).toEqual([
      {
        id: "card-400",
        date: "2026-08-16",
        amount: 281.93,
        description: settlement[0]?.description as string,
      },
    ]);
  });

  it("decides a settlement on the counterpart account, not on its wording", () => {
    // The description says "Betaling — Uitgavenstaat" on every settlement, in
    // the session's language. The account it moves money to does not.
    const frenchLooking = booking({
      hID: 500,
      amount: 120,
      description: "CARTE - Paiement - Relevé de dépenses - DOMICILI",
      counterpartAccount: "580000",
      counterpartId: "transfer-fr",
    });

    expect(read(frenchLooking).settlements).toHaveLength(1);
    expect(read(frenchLooking).charges).toEqual([]);
  });

  it("refuses to decide a charge with no line next to it", () => {
    const [cardLine] = missing;

    expect(read([cardLine as YukiLedgerLine]).charges[0]).toMatchObject({
      status: "needs_attention",
      attentionReason: "no_counterpart_line",
    });
  });

  it("holds back money arriving on the card that nothing explains", () => {
    // A settlement whose counterpart line is missing would otherwise be
    // imported as an ordinary transaction, which counts a whole month of
    // charges twice — and no status can undo that. Money *leaving* the card
    // is never a settlement, so an unpairable charge still comes through.
    const [settlementLine] = settlement;
    const ledger = read([settlementLine as YukiLedgerLine]);

    expect(ledger.charges).toEqual([]);
    expect(ledger.settlements).toEqual([]);
    expect(ledger.undecidedCredits).toEqual([
      {
        id: "card-400",
        date: "2026-08-16",
        amount: 281.93,
        description: settlementLine?.description as string,
      },
    ]);
  });

  it("still imports a refund it could pair, which is also money coming in", () => {
    const refund = booking({
      hID: 800,
      amount: 40,
      description: "MASTERCARD - Kaartverrichtingen - EXAMPLE SHOP REFUND",
      counterpartAccount: "440000",
      counterpartId: "supplier-refund",
    });

    expect(read(refund).charges[0]).toMatchObject({
      amount: 40,
      status: "in_the_books",
    });
  });

  it("refuses to decide when two lines sit next to the card line", () => {
    const [cardLine, counterpart] = missing;
    const duplicate = line({
      ...(counterpart as YukiLedgerLine),
      id: "supplier-duplicate",
      glAccountCode: "612100",
    });

    expect(
      read([
        cardLine as YukiLedgerLine,
        counterpart as YukiLedgerLine,
        duplicate,
      ]).charges[0],
    ).toMatchObject({
      status: "needs_attention",
      attentionReason: "ambiguous_counterpart_line",
    });
  });

  it("refuses to decide when the adjacent line describes something else", () => {
    const [cardLine, counterpart] = missing;

    expect(
      read([
        cardLine as YukiLedgerLine,
        line({
          ...(counterpart as YukiLedgerLine),
          description: "Something else",
        }),
      ]).charges[0],
    ).toMatchObject({
      status: "needs_attention",
      attentionReason: "description_differs",
    });
  });

  it("refuses to decide when the amounts are not exactly opposite", () => {
    const [cardLine, counterpart] = missing;

    expect(
      read([
        cardLine as YukiLedgerLine,
        line({ ...(counterpart as YukiLedgerLine), amount: 21.41 }),
      ]).charges[0],
    ).toMatchObject({
      status: "needs_attention",
      attentionReason: "amount_differs",
    });
  });

  it("pairs only within one statement, never across two", () => {
    const [cardLine] = missing;
    const otherStatement = line({
      id: "supplier-elsewhere",
      hID: 101,
      glAccountCode: "440000",
      amount: 21.4,
      statementId: "a-different-statement",
    });

    expect(
      read([cardLine as YukiLedgerLine, otherStatement]).charges[0],
    ).toMatchObject({ attentionReason: "no_counterpart_line" });
  });

  it("ignores every account that is not the card being read", () => {
    const otherCard = booking({
      hID: 600,
      amount: -9,
      description: "MASTERCARD - Kaartverrichtingen - SOMEONE ELSES CARD",
      counterpartAccount: "440000",
      counterpartId: "supplier-other-card",
    }).map((l) =>
      l.glAccountCode === CARD ? line({ ...l, glAccountCode: "434002" }) : l,
    );

    expect(read([...missing, ...otherCard]).charges.map((c) => c.id)).toEqual([
      "card-100",
    ]);
  });

  it("reports how far the card's lines reach, for the screen to say so", () => {
    const ledger = read([
      ...missing,
      ...booking({
        hID: 700,
        amount: -5,
        description: "MASTERCARD - Kaartverrichtingen - LATER",
        counterpartAccount: "440000",
        counterpartId: "supplier-later",
      }).map((l) => line({ ...l, date: "2026-08-23" })),
    ]);

    expect(ledger.reachesUpTo).toBe("2026-08-23");
  });
});
