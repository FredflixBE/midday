"use client";

import { useUserQuery } from "@/hooks/use-user";
import { formatConversion } from "@/utils/format";

/**
 * What a foreign-currency charge originally cost, said so that a person can read
 * it without already knowing (FF-1560).
 *
 * It replaces the unlabelled box that held `USD 18.60 at 1.15`, which failed
 * three ways at once: it carried a rate that could not be read and did not
 * reconcile; nothing said the two amounts were the same money; and it appeared
 * in the description field, where every other transaction shows free text, so
 * there was no cue it was a conversion at all.
 *
 * The wording lives in `formatConversion`, which is where it is tested.
 */
type Props = {
  originalAmount: number | null;
  originalCurrency: string | null;
  /** The currency the charge was settled in — what the amount above is in. */
  currency: string;
};

export function TransactionOriginalAmount({
  originalAmount,
  originalCurrency,
  currency,
}: Props) {
  const { data: user } = useUserQuery();

  const conversion = formatConversion({
    originalAmount,
    originalCurrency,
    currency,
    locale: user?.locale,
  });

  if (!conversion) return null;

  return (
    <span className="text-[#606060] text-xs select-text">{conversion}</span>
  );
}
