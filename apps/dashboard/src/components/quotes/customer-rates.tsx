"use client";

import type { RouterOutputs } from "@api/trpc/routers/_app";
import { CurrencyInput } from "@midday/ui/currency-input";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import {
  formatHourlyRate,
  hourlyRateAffixes,
} from "@/components/quotes/hourly-rate";
import { useTeamQuery } from "@/hooks/use-team";
import { useTRPC } from "@/trpc/client";
import { useErrorToast } from "./use-error-toast";

type Product = RouterOutputs["productRates"]["products"][number];

/**
 * A customer's own hourly rate per product (FF-1620). Empty means the
 * product's price applies; the price is the placeholder.
 */
export function CustomerRates({ customerId }: { customerId: string }) {
  const trpc = useTRPC();
  const { data: team } = useTeamQuery();
  // The team's, for a product without a currency of its own.
  const currency = team?.baseCurrency ?? "EUR";
  const { data: products } = useQuery(
    trpc.productRates.products.queryOptions(),
  );
  const { data: rates } = useQuery(
    trpc.productRates.customerRates.queryOptions({ customerId }),
  );

  if (!products || !rates) return null;

  const own = new Map(rates.map((r) => [r.productId, r.hourlyRate]));
  // An inactive product stays while this customer has a rate for it, so
  // that rate can still be seen and cleared.
  const shown = products.filter((p) => p.isActive || own.has(p.id));

  if (shown.length === 0) {
    return <div className="text-[14px] text-muted-foreground">-</div>;
  }

  return (
    <div className="grid grid-cols-2 gap-4">
      {shown.map((product) => (
        <RateField
          key={`${product.id}:${own.get(product.id)}`}
          customerId={customerId}
          product={product}
          currency={product.currency ?? currency}
          rate={own.get(product.id)}
        />
      ))}
    </div>
  );
}

function RateField({
  customerId,
  product,
  currency,
  rate,
}: {
  customerId: string;
  product: Product;
  currency: string;
  rate: number | undefined;
}) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const errorToast = useErrorToast();
  const [value, setValue] = useState<number | undefined>(rate);

  const set = useMutation(
    trpc.productRates.setCustomerRate.mutationOptions({
      onSettled: () =>
        queryClient.invalidateQueries({
          queryKey: trpc.productRates.customerRates.queryKey({ customerId }),
        }),
      onError: (error) => {
        setValue(rate);
        errorToast("That did not work")(error);
      },
    }),
  );

  const save = () => {
    if (value === rate) return;
    set.mutate({
      customerId,
      productId: product.id,
      hourlyRate: value ?? null,
    });
  };

  return (
    <div>
      <div className="text-[12px] mb-2 text-muted-foreground">
        {product.name}
      </div>
      <CurrencyInput
        aria-label={`${product.name} hourly rate`}
        value={value ?? ""}
        placeholder={
          product.price === null
            ? undefined
            : formatHourlyRate(product.price, currency)
        }
        onValueChange={(values) => setValue(values.floatValue)}
        onBlur={save}
        decimalScale={2}
        allowNegative={false}
        {...hourlyRateAffixes(currency)}
      />
    </div>
  );
}
