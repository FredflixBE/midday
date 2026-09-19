/**
 * The rhythm behind a supplier's payments (FF-1591).
 *
 * Pure, so detection, the attaching of a later payment and a dry run over the
 * live books all read a series the same way. What a commitment is, and why it
 * is one table for subscriptions and taxes alike, is ADR-48.
 *
 * A series is a chain: each payment lands one cadence after the one before,
 * give or take a few days, and — for a fixed price — costs about the same. A
 * chain may skip one occurrence, because a month the bank booked early or a
 * payment a person moved elsewhere should not end a subscription that plainly
 * continued.
 */

export type Cadence = "monthly" | "quarterly" | "yearly";
export type PriceKind = "fixed" | "fixed_foreign" | "usage";
export type CommitmentKind =
  | "subscription"
  | "direct_debit"
  | "leasing"
  | "tax";

export type SeriesPayment = {
  id: string;
  /** `YYYY-MM-DD`. */
  date: string;
  /** Signed as on the transaction: money out is negative. */
  amount: number;
  currency: string;
  /** What a foreign charge cost in the currency it was billed in. */
  originalAmount: number | null;
  originalCurrency: string | null;
};

export type DetectedSeries = {
  cadence: Cadence;
  priceKind: PriceKind;
  /** Oldest first. */
  payments: SeriesPayment[];
  /** The day of the month it lands on, from history. */
  day: number;
  /** What the next one is expected to cost, signed like the payments. */
  amount: number;
  currency: string;
  /** The range of recent occurrences. Equal to `amount` for a fixed price. */
  amountLow: number;
  amountHigh: number;
  /** The stable price in its own currency, for `fixed_foreign` only. */
  billedAmount: number | null;
  billedCurrency: string | null;
};

const MONTHS: Record<Cadence, number> = {
  monthly: 1,
  quarterly: 3,
  yearly: 12,
};

/**
 * How far from the expected day a payment may land and still be on rhythm.
 * Quarterly is wider because a quarterly invoice is paid when it is paid:
 * Four Eyes' landed 15 days early in August 2026.
 */
const TOLERANCE_DAYS: Record<Cadence, number> = {
  monthly: 7,
  quarterly: 16,
  yearly: 20,
};

/**
 * How far one occurrence's price may move from the last and still be the same
 * commitment. Wide enough for a price rise — Adobe went from €55.84 to €65.54
 * (+17%) — and narrow enough that Google's €13.99 and €39.00 subscriptions,
 * billed the same morning, are two.
 */
const PRICE_RATIO = 1.2;

/** A series needs this many payments, in this many different months. */
const MIN_PAYMENTS = 3;
const MIN_MONTHS = 3;

/**
 * And this many steps of exactly one cadence. Skips are allowed so a series
 * survives a missing month, but a chain of skips is a coincidence: three tax
 * payments two months apart are not a monthly rhythm.
 */
const MIN_REGULAR_STEPS = 2;

/** How many recent occurrences an estimate is taken from. */
const RECENT = 6;

/**
 * Only monthly and quarterly are detected. A yearly renewal needs three years
 * of history to show three payments, which these books do not have; a person
 * sets a commitment to yearly instead.
 */
const DETECTED_CADENCES: Cadence[] = ["monthly", "quarterly"];

function parse(date: string): Date {
  return new Date(`${date}T00:00:00Z`);
}

function format(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function daysBetween(a: string, b: string): number {
  return Math.round((parse(b).getTime() - parse(a).getTime()) / 86_400_000);
}

/** `date` moved on by whole months, on `day`, clamped to the month's end. */
function addMonths(date: string, months: number, day: number): string {
  const from = parse(date);
  const year = from.getUTCFullYear();
  const month = from.getUTCMonth() + months;
  const last = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return format(new Date(Date.UTC(year, month, Math.min(day, last))));
}

/**
 * How many cadences separate two payments — 1, or 2 when one occurrence was
 * skipped — or null when the second is off the rhythm.
 */
function stepsBetween(
  from: string,
  to: string,
  cadence: Cadence,
): 1 | 2 | null {
  const day = parse(from).getUTCDate();

  for (const steps of [1, 2] as const) {
    const expected = addMonths(from, MONTHS[cadence] * steps, day);
    if (Math.abs(daysBetween(expected, to)) <= TOLERANCE_DAYS[cadence]) {
      return steps;
    }
  }

  return null;
}

/** The price a payment is compared on: the billed one, for a foreign charge. */
function price(payment: SeriesPayment): { value: number; currency: string } {
  if (
    payment.originalAmount !== null &&
    payment.originalCurrency &&
    payment.originalCurrency !== payment.currency
  ) {
    return {
      value: Math.abs(payment.originalAmount),
      currency: payment.originalCurrency,
    };
  }
  return { value: Math.abs(payment.amount), currency: payment.currency };
}

function samePrice(a: SeriesPayment, b: SeriesPayment): boolean {
  const x = price(a);
  const y = price(b);
  if (x.currency !== y.currency) return false;
  const low = Math.min(x.value, y.value);
  const high = Math.max(x.value, y.value);
  return low > 0 && high / low <= PRICE_RATIO;
}

type Chain = { payments: SeriesPayment[]; regularSteps: number };

/**
 * The longest chain through these payments on this cadence. Dynamic
 * programming over the payments in date order: each one extends the longest
 * chain ending on a payment it follows on rhythm.
 */
function longestChain(
  payments: SeriesPayment[],
  cadence: Cadence,
  byPrice: boolean,
): Chain | null {
  const best: { length: number; regular: number; previous: number }[] = [];

  for (const [i, payment] of payments.entries()) {
    best[i] = { length: 1, regular: 0, previous: -1 };

    for (let j = 0; j < i; j++) {
      const before = payments[j]!;
      const steps = stepsBetween(before.date, payment.date, cadence);
      if (steps === null) continue;
      if (byPrice && !samePrice(before, payment)) continue;

      const length = best[j]!.length + 1;
      const regular = best[j]!.regular + (steps === 1 ? 1 : 0);
      if (
        length > best[i]!.length ||
        (length === best[i]!.length && regular > best[i]!.regular)
      ) {
        best[i] = { length, regular, previous: j };
      }
    }
  }

  let end = -1;
  for (const [i, entry] of best.entries()) {
    // `>=`: of two chains as long, the one that ends later, which is the one
    // still running.
    if (end === -1 || entry.length >= best[end]!.length) end = i;
  }
  if (end === -1) return null;

  const chain: SeriesPayment[] = [];
  for (let i = end; i !== -1; i = best[i]!.previous) {
    chain.unshift(payments[i]!);
  }

  return { payments: chain, regularSteps: best[end]!.regular };
}

function isSeries(chain: Chain | null, cadence: Cadence, today: string) {
  if (!chain) return false;
  if (chain.payments.length < MIN_PAYMENTS) return false;
  if (chain.regularSteps < MIN_REGULAR_STEPS) return false;

  const months = new Set(chain.payments.map((p) => p.date.slice(0, 7)));
  if (months.size < MIN_MONTHS) return false;

  return !wentQuiet(chain.payments.at(-1)!.date, cadence, today);
}

/**
 * A payee that simply went quiet is not predicted: two missed occurrences and
 * it is history, not a commitment. Read at detection and again whenever a
 * commitment's next date is asked for.
 */
export function wentQuiet(
  lastDate: string,
  cadence: Cadence,
  today: string,
): boolean {
  const quietFrom = addMonths(
    lastDate,
    MONTHS[cadence] * 2,
    parse(lastDate).getUTCDate(),
  );
  return daysBetween(quietFrom, today) > TOLERANCE_DAYS[cadence];
}

/**
 * A chain has to be most of what the supplier was paid over its span — at a
 * like price, when the price is read. Otherwise anyone paid often — a taxi, a
 * fuel station, a weekly coffee — holds a monthly-looking chain or five, one
 * payment picked from each month. Google's three subscriptions billed the same
 * morning still pass, because each is compared only with its own price.
 */
const COVERAGE = 2 / 3;

function coversItsSpan(
  chain: SeriesPayment[],
  payments: readonly SeriesPayment[],
  byPrice: boolean,
): boolean {
  const first = chain[0]!.date;
  const last = chain.at(-1)!.date;
  const inSpan = payments.filter(
    (p) =>
      p.date >= first &&
      p.date <= last &&
      (!byPrice || chain.some((member) => samePrice(member, p))),
  );
  return chain.length >= inSpan.length * COVERAGE;
}

/**
 * The day of the month a series lands on. A median taken around the last
 * payment's day, wrapping at the month's end, so a debit that falls on the
 * 31st one month and the 1st the next lands on the 1st — not on the 15th, as
 * a plain median of 31s and 1s would say.
 */
function landingDay(chain: SeriesPayment[]): number {
  const base = parse(chain.at(-1)!.date).getUTCDate();
  const offsets = chain.map((p) => {
    const offset = parse(p.date).getUTCDate() - base;
    return offset > 15 ? offset - 31 : offset < -15 ? offset + 31 : offset;
  });
  const day = base + Math.round(median(offsets));
  return day < 1 ? day + 31 : day > 31 ? day - 31 : day;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]!
    : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function summarise(chain: SeriesPayment[], cadence: Cadence): DetectedSeries {
  const recent = chain.slice(-RECENT);
  const last = chain.at(-1)!;
  const amounts = recent.map((p) => p.amount);
  // The last two, not more: KBC Verzekeringen went from €196.79 to €202.98
  // two months ago and is a fixed price all the same.
  const tail = chain.slice(-2);

  const billed = price(last);
  const foreign = billed.currency !== last.currency;
  const stable = tail.every(
    (p) =>
      price(p).currency === billed.currency && price(p).value === billed.value,
  );

  const priceKind: PriceKind = !stable
    ? "usage"
    : foreign
      ? "fixed_foreign"
      : "fixed";

  const amount = priceKind === "fixed" ? last.amount : round2(median(amounts));

  return {
    cadence,
    priceKind,
    payments: chain,
    day: landingDay(chain),
    amount,
    currency: last.currency,
    amountLow: priceKind === "fixed" ? amount : Math.min(...amounts),
    amountHigh: priceKind === "fixed" ? amount : Math.max(...amounts),
    billedAmount: priceKind === "fixed_foreign" ? billed.value : null,
    billedCurrency: priceKind === "fixed_foreign" ? billed.currency : null,
  };
}

/**
 * Every series in one supplier's payments, the payments no commitment holds
 * yet.
 *
 * Fixed prices first, one chain at a time, so a supplier billing three
 * subscriptions gives three series rather than one muddle. What is left is
 * read once more with the price ignored, which is how usage — Google Cloud,
 * VAB, a VAT bill — shows up: the rhythm is steady and the amount is not.
 */
export function detectSeries(
  payments: readonly SeriesPayment[],
  params: { today: string },
): DetectedSeries[] {
  let open = [...payments].sort(
    (a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id),
  );
  const found: DetectedSeries[] = [];

  for (const byPrice of [true, false]) {
    for (const cadence of DETECTED_CADENCES) {
      // A chain that is not a series — a payee gone quiet, three payments in
      // two months — is set aside for this pass, so a shorter one that is can
      // still be found.
      let pool = open;

      for (;;) {
        const chain = longestChain(pool, cadence, byPrice);
        if (!chain || chain.payments.length < MIN_PAYMENTS) break;

        const ids = new Set(chain.payments.map((p) => p.id));
        pool = pool.filter((p) => !ids.has(p.id));

        if (
          isSeries(chain, cadence, params.today) &&
          coversItsSpan(chain.payments, open, byPrice)
        ) {
          found.push(summarise(chain.payments, cadence));
          open = open.filter((p) => !ids.has(p.id));
        }
      }
    }
  }

  return found;
}

/**
 * Does `payment` continue a commitment whose last payment was `last`? On its
 * rhythm, and — for a fixed price — at about the price, compared in the
 * currency it is billed in.
 */
export function extendsSeries(
  commitment: { cadence: Cadence; priceKind: PriceKind },
  last: SeriesPayment,
  payment: SeriesPayment,
): boolean {
  if (payment.date <= last.date) return false;
  if (stepsBetween(last.date, payment.date, commitment.cadence) === null) {
    return false;
  }
  if (commitment.priceKind === "usage") return true;
  return samePrice(last, payment);
}

/** When the next one is due: one cadence after the last, on its day. */
export function nextOccurrence(
  lastDate: string,
  cadence: Cadence,
  day: number,
): string {
  return addMonths(lastDate, MONTHS[cadence], day);
}

const TAX_CATEGORY = /tax|vat/;

/**
 * What kind of commitment a series is, from its payments' categories and how
 * they were paid. A first guess a person corrects, not a rule about Belgian
 * taxes: the category already says what the payment was.
 */
export function kindOf(
  payments: readonly { categorySlug: string | null; method: string }[],
): CommitmentKind {
  const votes = new Map<CommitmentKind, number>();

  for (const payment of payments) {
    const kind: CommitmentKind =
      payment.categorySlug && TAX_CATEGORY.test(payment.categorySlug)
        ? "tax"
        : payment.categorySlug === "leases"
          ? "leasing"
          : payment.method === "card_purchase"
            ? "subscription"
            : "direct_debit";
    votes.set(kind, (votes.get(kind) ?? 0) + 1);
  }

  let winner: CommitmentKind = "direct_debit";
  let most = 0;
  for (const [kind, count] of votes) {
    if (count > most) {
      winner = kind;
      most = count;
    }
  }
  return winner;
}
