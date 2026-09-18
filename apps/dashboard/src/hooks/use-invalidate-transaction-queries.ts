"use client";

import { useQueryClient } from "@tanstack/react-query";
import { useTRPC } from "@/trpc/client";

export function useInvalidateTransactionQueries() {
  const trpc = useTRPC();
  const queryClient = useQueryClient();

  return () => {
    // Invalidate transaction queries
    queryClient.invalidateQueries({
      queryKey: trpc.transactions.get.infiniteQueryKey(),
    });

    queryClient.invalidateQueries({
      queryKey: trpc.transactions.getById.queryKey(),
    });

    // Invalidate reports queries
    queryClient.invalidateQueries({
      queryKey: trpc.reports.revenue.queryKey(),
    });

    queryClient.invalidateQueries({
      queryKey: trpc.reports.profit.queryKey(),
    });

    queryClient.invalidateQueries({
      queryKey: trpc.reports.expense.queryKey(),
    });

    queryClient.invalidateQueries({
      queryKey: trpc.reports.spending.queryKey(),
    });

    queryClient.invalidateQueries({
      queryKey: trpc.reports.taxSummary.queryKey(),
    });

    queryClient.invalidateQueries({
      queryKey: trpc.reports.revenueForecast.queryKey(),
    });

    // Invalidate overview summary
    queryClient.invalidateQueries({
      queryKey: trpc.overview.summary.queryKey(),
    });

    // The missing-invoices page is a list you work until it is empty, so it has
    // to empty as you work it — attaching a document is the main way a payment
    // leaves it (FF-1552).
    queryClient.invalidateQueries({
      queryKey: trpc.transactions.missingInvoices.queryKey(),
    });

    // A payment's supplier changes the counts on the suppliers page (FF-1555).
    queryClient.invalidateQueries({
      queryKey: trpc.suppliers.list.queryKey(),
    });
    queryClient.invalidateQueries({
      queryKey: trpc.suppliers.transactions.queryKey(),
    });

    // Invalidate global search
    queryClient.invalidateQueries({
      queryKey: trpc.search.global.queryKey(),
    });
  };
}
