import { describe, expect, test } from "bun:test";
import {
  detectSeries,
  extendsSeries,
  kindOf,
  nextOccurrence,
  type SeriesPayment,
} from "./commitment-series";

/**
 * The series here are the live books' own (measured 2026-09-19), amounts and
 * dates as they are, because the cases worth holding are the untidy ones: a
 * price that rose mid-series, three subscriptions from one supplier, a charge
 * a few days early.
 */

let sequence = 0;

function pay(
  date: string,
  amount: number,
  original?: [number, string],
): SeriesPayment {
  sequence++;
  return {
    id: `p${sequence}`,
    date,
    amount,
    currency: "EUR",
    originalAmount: original?.[0] ?? null,
    originalCurrency: original?.[1] ?? null,
  };
}

const TODAY = "2026-09-19";

describe("detectSeries", () => {
  test("a fixed monthly price is one fixed series, landing on its day", () => {
    const payments = [
      pay("2026-01-30", -5.66, [6.62, "USD"]),
      ...["02-28", "03-30", "04-30", "05-30", "06-30", "07-30"].map((day) =>
        pay(`2026-${day}`, -17.38),
      ),
    ];

    const [cursor, ...rest] = detectSeries(payments, { today: TODAY });

    expect(rest).toEqual([]);
    expect(cursor).toMatchObject({
      cadence: "monthly",
      priceKind: "fixed",
      amount: -17.38,
      day: 30,
    });
    expect(cursor?.payments).toHaveLength(6);
  });

  test("a price rise continues the series rather than starting another", () => {
    const payments = [
      ...["01", "02", "03", "04"].map((month) =>
        pay(`2026-${month}-08`, -55.84),
      ),
      ...["05", "06", "07", "08"].map((month) =>
        pay(`2026-${month}-08`, -65.54),
      ),
    ];

    const series = detectSeries(payments, { today: TODAY });

    expect(series).toHaveLength(1);
    expect(series[0]?.payments).toHaveLength(8);
    expect(series[0]?.amount).toBe(-65.54);
    expect(series[0]?.priceKind).toBe("fixed");
  });

  test("a price that rose two months ago is still a fixed price", () => {
    const payments = [
      ...["03", "04", "05", "06"].map((month) =>
        pay(`2026-${month}-28`, -196.79),
      ),
      pay("2026-07-28", -202.98),
      pay("2026-08-28", -202.98),
    ];

    const [insurance] = detectSeries(payments, { today: TODAY });

    expect(insurance).toMatchObject({ priceKind: "fixed", amount: -202.98 });
  });

  test("a quarterly invoice paid two weeks early stays on rhythm", () => {
    const payments = [
      pay("2025-11-10", -1330),
      pay("2026-02-16", -1359.79),
      pay("2026-05-18", -1359.79),
      pay("2026-08-03", -1359.79),
    ];

    const [accountant] = detectSeries(payments, { today: TODAY });

    expect(accountant?.cadence).toBe("quarterly");
    expect(accountant?.payments).toHaveLength(4);
  });

  test("one supplier billing three subscriptions is three series", () => {
    // Google: 13.99 all year, 39.00 all year, 8.10 since May — all on the 2nd.
    const payments: SeriesPayment[] = [];
    for (const month of ["01", "02", "03", "04", "05", "06", "07", "08"]) {
      payments.push(pay(`2026-${month}-02`, -13.99));
      payments.push(pay(`2026-${month}-02`, -39));
      if (month >= "05") payments.push(pay(`2026-${month}-02`, -8.1));
    }

    const series = detectSeries(payments, { today: TODAY });

    expect(
      series.map((one) => [one.amount, one.payments.length]).sort(),
    ).toEqual(
      [
        [-13.99, 8],
        [-39, 8],
        [-8.1, 4],
      ].sort(),
    );
  });

  test("a stable dollar price is fixed_foreign, whatever the euro did", () => {
    const payments = [
      ["08-16", -25.34],
      ["09-16", -25.15],
      ["10-16", -25.4],
      ["11-16", -24.87],
    ].map(([day, eur]) => pay(`2026-${day}`, eur as number, [29, "USD"]));

    const [lemon] = detectSeries(payments, { today: "2026-11-20" });

    expect(lemon).toMatchObject({
      priceKind: "fixed_foreign",
      billedAmount: 29,
      billedCurrency: "USD",
      amountLow: -25.4,
      amountHigh: -24.87,
    });
  });

  test("amounts that move every month are a usage series with a range", () => {
    const payments = [
      ["10-10", -192.76],
      ["11-13", -147.29],
      ["12-10", -142.38],
      ["01-14", -211.32],
      ["02-13", -54.86],
      ["03-17", -201.44],
    ].map(([day, amount], index) =>
      pay(`${index < 3 ? 2025 : 2026}-${day}`, amount as number),
    );

    const [vab, ...rest] = detectSeries(payments, { today: "2026-03-20" });

    expect(rest).toEqual([]);
    expect(vab).toMatchObject({
      cadence: "monthly",
      priceKind: "usage",
      amountLow: -211.32,
      amountHigh: -54.86,
    });
    expect(vab?.payments).toHaveLength(6);
  });

  test("a payment a few days early, or a month skipped, does not break it", () => {
    const payments = [
      pay("2026-03-03", -28.44),
      pay("2026-04-03", -28.44),
      pay("2026-05-05", -28.44),
      pay("2026-05-29", -28.44),
      pay("2026-08-01", -28.44),
    ];

    const [yuki] = detectSeries(payments, { today: TODAY });

    expect(yuki?.payments).toHaveLength(5);
  });

  test("a quarterly rhythm is quarterly", () => {
    const payments = [
      pay("2025-10-21", -5209),
      pay("2026-01-19", -5977.82),
      pay("2026-04-20", -3699.32),
      pay("2026-07-20", -4100),
    ];

    const [vat] = detectSeries(payments, { today: TODAY });

    expect(vat).toMatchObject({ cadence: "quarterly", day: 20 });
  });

  test("two payments, or three in two months, are not a rhythm", () => {
    expect(
      detectSeries([pay("2026-07-01", -10), pay("2026-08-01", -10)], {
        today: TODAY,
      }),
    ).toEqual([]);
    expect(
      detectSeries(
        [
          pay("2026-07-01", -10),
          pay("2026-07-29", -10),
          pay("2026-08-27", -10),
        ],
        { today: "2026-08-30" },
      ),
    ).toEqual([]);
  });

  test("a payee that went quiet is not proposed", () => {
    // AWS: five months, then nothing since January.
    const payments = ["09", "10", "11", "12"]
      .map((month) => pay(`2025-${month}-02`, -7.72))
      .concat(pay("2026-01-02", -6.85));

    expect(detectSeries(payments, { today: TODAY })).toEqual([]);
  });

  test("an old series that ended does not hide a current one", () => {
    // Anthropic: a long run that stopped in 2025, and a shorter one since.
    const payments = [
      ...["01", "02", "03", "04", "05", "06"].map((month) =>
        pay(`2025-${month}-16`, -180),
      ),
      ...["06", "07", "08", "09"].map((month) => pay(`2026-${month}-01`, -180)),
    ];

    const series = detectSeries(payments, { today: TODAY });

    expect(series).toHaveLength(1);
    expect(series[0]?.payments[0]?.date).toBe("2026-06-01");
  });

  test("someone paid every week is not a monthly commitment", () => {
    // A taxi, a fuel station: one payment picked from each month makes a
    // chain, and the rest of the month says it is not one.
    const payments: SeriesPayment[] = [];
    for (let week = 0; week < 28; week++) {
      const date = new Date(Date.UTC(2026, 2, 2 + week * 7));
      payments.push(
        pay(date.toISOString().slice(0, 10), -20 - ((week * 7) % 30)),
      );
    }

    expect(detectSeries(payments, { today: TODAY })).toEqual([]);
  });

  test("a debit on the 31st one month and the 1st the next lands on the 1st", () => {
    const payments = [
      ["2026-03-31", -100],
      ["2026-05-01", -130],
      ["2026-05-29", -90],
      ["2026-07-01", -160],
      ["2026-07-31", -70],
      ["2026-09-01", -120],
    ].map(([date, amount]) => pay(date as string, amount as number));

    const [series] = detectSeries(payments, { today: TODAY });

    expect(series?.day).toBe(1);
  });

  test("scattered one-offs are left alone", () => {
    const payments = [
      pay("2026-02-02", -41.59),
      pay("2026-02-19", -3.2),
      pay("2026-06-11", -900),
    ];

    expect(detectSeries(payments, { today: TODAY })).toEqual([]);
  });
});

describe("extendsSeries", () => {
  const monthly = {
    cadence: "monthly" as const,
    priceKind: "fixed" as const,
  };

  test("next month's payment at the price extends it", () => {
    expect(
      extendsSeries(
        monthly,
        pay("2026-07-30", -17.38),
        pay("2026-08-30", -17.38),
      ),
    ).toBe(true);
  });

  test("a payment at another price the same day does not", () => {
    expect(
      extendsSeries(monthly, pay("2026-07-02", -13.99), pay("2026-08-02", -39)),
    ).toBe(false);
  });

  test("a usage series takes any amount, on its rhythm", () => {
    expect(
      extendsSeries(
        { ...monthly, priceKind: "usage" },
        pay("2026-07-13", -89.03),
        pay("2026-08-14", -243.64),
      ),
    ).toBe(true);
  });

  test("a foreign price is compared in the currency it was billed in", () => {
    expect(
      extendsSeries(
        { ...monthly, priceKind: "fixed_foreign" },
        pay("2026-07-16", -25.84, [29, "USD"]),
        pay("2026-08-16", -25.57, [29, "USD"]),
      ),
    ).toBe(true);
  });
});

describe("nextOccurrence", () => {
  test("the cadence after the last payment, on the commitment's day", () => {
    expect(nextOccurrence("2026-07-30", "monthly", 30)).toBe("2026-08-30");
    expect(nextOccurrence("2026-01-30", "monthly", 30)).toBe("2026-02-28");
    expect(nextOccurrence("2026-07-20", "quarterly", 20)).toBe("2026-10-20");
    expect(nextOccurrence("2025-11-04", "yearly", 4)).toBe("2026-11-04");
  });
});

describe("kindOf", () => {
  test("taxes and leases by their category, cards as subscriptions", () => {
    expect(
      kindOf([{ categorySlug: "vat-gst-pst-qst-payments", method: "other" }]),
    ).toBe("tax");
    expect(kindOf([{ categorySlug: "employer-taxes", method: "other" }])).toBe(
      "tax",
    );
    expect(kindOf([{ categorySlug: "leases", method: "other" }])).toBe(
      "leasing",
    );
    expect(
      kindOf([{ categorySlug: "software", method: "card_purchase" }]),
    ).toBe("subscription");
    expect(kindOf([{ categorySlug: "utilities", method: "other" }])).toBe(
      "direct_debit",
    );
  });
});
