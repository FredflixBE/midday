"use client";

import type { RouterOutputs } from "@api/trpc/routers/_app";
import { CurrencyInput } from "@midday/ui/currency-input";
import { useToast } from "@midday/ui/use-toast";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useTRPC } from "@/trpc/client";

type WorkType = RouterOutputs["workTypes"]["list"][number];

/**
 * A customer's own hourly rate per work type (FF-1607). Empty means the work
 * type's default applies; the default is the placeholder.
 */
export function CustomerRates({ customerId }: { customerId: string }) {
  const trpc = useTRPC();
  const { data: workTypes } = useQuery(trpc.workTypes.list.queryOptions());
  const { data: rates } = useQuery(
    trpc.workTypes.customerRates.queryOptions({ customerId }),
  );

  if (!workTypes || !rates) return null;

  if (workTypes.length === 0) {
    return <div className="text-[14px] text-[#606060]">-</div>;
  }

  const own = new Map(rates.map((r) => [r.workTypeId, r.hourlyRate]));

  return (
    <div className="grid grid-cols-2 gap-4">
      {workTypes.map((workType) => (
        <RateField
          key={workType.id}
          customerId={customerId}
          workType={workType}
          rate={own.get(workType.id)}
        />
      ))}
    </div>
  );
}

function RateField({
  customerId,
  workType,
  rate,
}: {
  customerId: string;
  workType: WorkType;
  rate: number | undefined;
}) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [value, setValue] = useState<number | undefined>(rate);

  const set = useMutation(
    trpc.workTypes.setCustomerRate.mutationOptions({
      onSettled: () =>
        queryClient.invalidateQueries({
          queryKey: trpc.workTypes.customerRates.queryKey({ customerId }),
        }),
      onError: (error) => {
        setValue(rate);
        toast({
          duration: 6000,
          variant: "error",
          title: "That did not work",
          description: error.message,
        });
      },
    }),
  );

  const save = () => {
    if (value === rate) return;
    set.mutate({
      customerId,
      workTypeId: workType.id,
      hourlyRate: value ?? null,
    });
  };

  return (
    <div>
      <div className="text-[12px] mb-2 text-[#606060]">{workType.name}</div>
      <CurrencyInput
        aria-label={`${workType.name} hourly rate`}
        value={value ?? ""}
        placeholder={`${workType.hourlyRate} ${workType.currency}/h`}
        onValueChange={(values) => setValue(values.floatValue)}
        onBlur={save}
        decimalScale={2}
        allowNegative={false}
        suffix={` ${workType.currency}/h`}
      />
    </div>
  );
}
