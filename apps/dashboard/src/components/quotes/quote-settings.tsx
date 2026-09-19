"use client";

import { Button } from "@midday/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@midday/ui/card";
import { CurrencyInput } from "@midday/ui/currency-input";
import { Input } from "@midday/ui/input";
import { useToast } from "@midday/ui/use-toast";
import {
  useMutation,
  useQueryClient,
  useSuspenseQuery,
} from "@tanstack/react-query";
import { useState } from "react";
import { useTRPC } from "@/trpc/client";

/**
 * Settings → Quotes (FF-1609): the number prefix, how long a new quote is
 * valid, and the hours in a day used to show days.
 */
export function QuoteSettings() {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { data } = useSuspenseQuery(trpc.quotes.settings.queryOptions());

  const [numberPrefix, setNumberPrefix] = useState(data.numberPrefix);
  const [validDays, setValidDays] = useState<number | undefined>(
    data.defaultValidDays,
  );
  const [hoursPerDay, setHoursPerDay] = useState<number | undefined>(
    data.hoursPerDay,
  );

  const save = useMutation(
    trpc.quotes.updateSettings.mutationOptions({
      onSuccess: (settings) =>
        queryClient.setQueryData(trpc.quotes.settings.queryKey(), settings),
      onError: (error) =>
        toast({
          duration: 6000,
          variant: "error",
          title: "That did not work",
          description: error.message,
        }),
    }),
  );

  const valid = validDays !== undefined && hoursPerDay !== undefined;

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (!valid) return;
        save.mutate({
          numberPrefix,
          defaultValidDays: validDays,
          hoursPerDay,
        });
      }}
    >
      <Card>
        <CardHeader>
          <CardTitle>Quotes</CardTitle>
        </CardHeader>
        <CardContent className="grid grid-cols-3 gap-4">
          <div className="space-y-2 text-sm">
            <label htmlFor="quote-number-prefix" className="text-[#606060]">
              Number prefix
            </label>
            <Input
              id="quote-number-prefix"
              value={numberPrefix}
              onChange={(e) => setNumberPrefix(e.target.value)}
              maxLength={20}
            />
          </div>
          <div className="space-y-2 text-sm">
            <label htmlFor="quote-valid-days" className="text-[#606060]">
              Valid for (days)
            </label>
            <CurrencyInput
              id="quote-valid-days"
              value={validDays ?? ""}
              onValueChange={(values) => setValidDays(values.floatValue)}
              decimalScale={0}
              allowNegative={false}
              thousandSeparator={false}
            />
          </div>
          <div className="space-y-2 text-sm">
            <label htmlFor="quote-hours-per-day" className="text-[#606060]">
              Hours per day
            </label>
            <CurrencyInput
              id="quote-hours-per-day"
              value={hoursPerDay ?? ""}
              onValueChange={(values) => setHoursPerDay(values.floatValue)}
              decimalScale={2}
              allowNegative={false}
              thousandSeparator={false}
            />
          </div>
          <div className="col-span-3 flex justify-end">
            <Button
              type="submit"
              variant="outline"
              disabled={!valid || save.isPending}
            >
              Save
            </Button>
          </div>
        </CardContent>
      </Card>
    </form>
  );
}
