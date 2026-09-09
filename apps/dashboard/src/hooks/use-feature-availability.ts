import { useQuery } from "@tanstack/react-query";
import { useTRPC } from "@/trpc/client";

/**
 * Which optional features this deployment has credentials for.
 *
 * Rendering an entry point whose backend has no key gives the user a button
 * that only ever errors, so ask before drawing one. While the answer is in
 * flight everything reads as unavailable — briefly missing beats briefly
 * broken.
 */
export function useFeatureAvailability() {
  const trpc = useTRPC();

  const { data } = useQuery(
    trpc.apps.availability.queryOptions(undefined, {
      staleTime: 30 * 60 * 1000,
    }),
  );

  return {
    assistant: data?.assistant ?? false,
    connectors: data?.connectors ?? false,
    enrichment: data?.enrichment ?? false,
    fortnox: data?.fortnox ?? false,
    insights: data?.insights ?? false,
    quickbooks: data?.quickbooks ?? false,
    slack: data?.slack ?? false,
    stripe: data?.stripe ?? false,
    xero: data?.xero ?? false,
  };
}
