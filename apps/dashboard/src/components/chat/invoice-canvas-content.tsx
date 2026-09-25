"use client";

import {
  useQuery,
  useQueryClient,
  useSuspenseQuery,
} from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import { Form } from "@/components/invoice/form";
import { FormContext } from "@/components/invoice/form-context";
import { InvoiceSuccess } from "@/components/invoice-success";
import { useInvoiceParams } from "@/hooks/use-invoice-params";
import { useInvoiceEditorStore } from "@/store/invoice-editor";
import { useTRPC } from "@/trpc/client";

export function InvoiceCanvasContent() {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const { invoiceType, invoiceId } = useInvoiceParams();
  const prevInvoiceIdRef = useRef(invoiceId);

  useEffect(() => {
    if (prevInvoiceIdRef.current && prevInvoiceIdRef.current !== invoiceId) {
      useInvoiceEditorStore.getState().reset();
      queryClient.invalidateQueries({
        queryKey: trpc.invoice.getById.queryKey(),
      });
    }
    prevInvoiceIdRef.current = invoiceId;
  }, [invoiceId, queryClient, trpc.invoice.getById]);

  const { data: defaultSettings } = useSuspenseQuery(
    trpc.invoice.defaultSettings.queryOptions(),
  );

  const { data } = useQuery(
    trpc.invoice.getById.queryOptions(
      { id: invoiceId! },
      { enabled: !!invoiceId, staleTime: 30 * 1000 },
    ),
  );

  return (
    <FormContext defaultSettings={defaultSettings} data={data}>
      <div className="flex flex-col h-full">
        <div className="flex-1 min-h-0">
          {invoiceType === "success" ? <InvoiceSuccess /> : <Form />}
        </div>
      </div>
    </FormContext>
  );
}
