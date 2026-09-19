"use client";

import type { RouterOutputs } from "@api/trpc/routers/_app";
import type { QuoteContent, QuoteKind } from "@midday/quote";
import { useToast } from "@midday/ui/use-toast";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTRPC } from "@/trpc/client";

type Quote = RouterOutputs["quotes"]["get"];
type Version = Quote["versions"][number];

export type QuoteDraft = {
  title: string;
  kind: QuoteKind;
  language: "nl" | "en";
  /** Null once the customer was deleted. */
  customerId: string | null;
  mode: "estimate" | "firm";
  issueDate: string;
  validUntil: string;
  content: QuoteContent;
};

export type DraftChange =
  | Partial<QuoteDraft>
  | ((draft: QuoteDraft) => Partial<QuoteDraft>);

/** Quiet time after the last change before it is saved. */
const SAVE_DELAY_MS = 600;

/**
 * One version as the editor holds it (FF-1611). Every change shows at once
 * and is saved shortly after, whole: the changed header fields and the full
 * content in one `updateDraft`, so a switch of kind and the scenarios made to
 * match it are never saved apart. The editor keeps its own copy while it is
 * open; what the server returns only refreshes the cache.
 */
export function useQuoteDraft(quote: Quote, version: Version) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const initial = (): QuoteDraft => ({
    title: quote.title,
    kind: quote.kind,
    language: quote.language as QuoteDraft["language"],
    customerId: quote.customerId,
    mode: version.mode,
    issueDate: version.issueDate,
    validUntil: version.validUntil,
    content: version.content as QuoteContent,
  });

  const [draft, setDraft] = useState<QuoteDraft>(initial);
  const current = useRef(draft);
  const pending = useRef<Partial<QuoteDraft>>({});
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const save = useMutation({
    ...trpc.quotes.updateDraft.mutationOptions({
      onSuccess: (saved) =>
        queryClient.setQueryData(
          trpc.quotes.get.queryKey({ id: quote.id }),
          saved,
        ),
      onError: (error) =>
        toast({
          duration: 6000,
          variant: "error",
          title: "Not saved",
          description: error.message,
        }),
    }),
    // One save at a time, in the order the changes were made.
    scope: { id: `quote-draft-${version.id}` },
  });

  const flush = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    const changes = pending.current;
    pending.current = {};
    if (Object.keys(changes).length === 0) return;
    save.mutate({
      versionId: version.id,
      ...changes,
      customerId: changes.customerId ?? undefined,
    });
  }, [save.mutate, version.id]);

  const change = useCallback(
    (next: DraftChange) => {
      const changes = typeof next === "function" ? next(current.current) : next;
      current.current = { ...current.current, ...changes };
      setDraft(current.current);
      Object.assign(pending.current, changes);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(flush, SAVE_DELAY_MS);
    },
    [flush],
  );

  // Leaving the page saves what is waiting; closing the tab asks first.
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => {
      if (Object.keys(pending.current).length > 0) {
        flush();
        event.preventDefault();
      }
    };
    window.addEventListener("beforeunload", warn);
    return () => {
      window.removeEventListener("beforeunload", warn);
      flush();
    };
  }, [flush]);

  return { draft, change, isSaving: save.isPending };
}
