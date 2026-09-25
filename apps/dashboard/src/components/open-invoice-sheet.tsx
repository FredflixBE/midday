"use client";

import { Button } from "@midday/ui/button";
import { Icons } from "@midday/ui/icons";
import { preloadInvoiceSheet } from "@/components/sheets/load-invoice-sheet";
import { useInvoiceParams } from "@/hooks/use-invoice-params";

export function OpenInvoiceSheet() {
  const { setParams } = useInvoiceParams();

  return (
    <div>
      <Button
        variant="outline"
        size="icon"
        onPointerEnter={preloadInvoiceSheet}
        onFocus={preloadInvoiceSheet}
        onClick={() => setParams({ invoiceType: "create" })}
      >
        <Icons.Add />
      </Button>
    </div>
  );
}
