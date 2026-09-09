import { useMutation } from "@tanstack/react-query";
import type { MutableRefObject } from "react";
import { useTRPC } from "@/trpc/client";
import { EnableBankingConnect } from "./enablebanking-connect";
import { GoCardLessConnect } from "./gocardless-connect";

type Props = {
  id: string;
  provider: string;
  availableHistory: number;
  redirectPath?: string;
  countryCode?: string;
  connectRef?: MutableRefObject<(() => void) | null>;
};

export function ConnectBankProvider({
  id,
  provider,
  availableHistory,
  redirectPath,
  countryCode,
  connectRef,
}: Props) {
  const trpc = useTRPC();
  const updateUsageMutation = useMutation(
    trpc.institutions.updateUsage.mutationOptions(),
  );

  const updateUsage = () => {
    updateUsageMutation.mutate({ id });
  };

  switch (provider) {
    case "gocardless": {
      return (
        <GoCardLessConnect
          id={id}
          availableHistory={availableHistory}
          onSelect={() => {
            updateUsage();
          }}
          redirectPath={redirectPath}
          connectRef={connectRef}
        />
      );
    }
    case "enablebanking": {
      return (
        <EnableBankingConnect
          institutionId={id}
          countryCode={countryCode}
          onSelect={() => {
            updateUsage();
          }}
          redirectPath={redirectPath}
          connectRef={connectRef}
        />
      );
    }
    default:
      return null;
  }
}
