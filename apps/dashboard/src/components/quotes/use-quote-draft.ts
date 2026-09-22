"use client";

import type { RouterOutputs } from "@api/trpc/routers/_app";
import type { QuoteContent, QuoteKind } from "@midday/quote";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTRPC } from "@/trpc/client";
import { planRetry } from "./save-retry";
import { useErrorToast } from "./use-error-toast";

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
  const errorToast = useErrorToast();

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
  // Refusals in a row. A save that lands clears it, and so does giving up, so
  // the next edit starts a fresh run of attempts rather than one more.
  const failures = useRef(0);
  // False once the editor is gone, so a refusal on the way out is not retried.
  const alive = useRef(true);
  // The last save sent; saves run one at a time, so it settles last.
  const lastSave = useRef<Promise<boolean>>(Promise.resolve(true));

  // Read when a retry is due, which is after any render that changed them.
  const notSaved = useRef(errorToast("Not saved"));
  const retry = useRef<() => void>(() => {});

  const save = useMutation({
    ...trpc.quotes.updateDraft.mutationOptions({
      onSuccess: (saved) => {
        queryClient.setQueryData(
          trpc.quotes.get.queryKey({ id: quote.id }),
          saved,
        );
        // Its title, customer or amount may read differently in the list.
        void queryClient.invalidateQueries({
          queryKey: trpc.quotes.list.queryKey(),
        });
      },
      // No toast here: a blip is sent again on its own, and only having
      // given up is worth interrupting someone who is still typing.
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
    lastSave.current = save
      .mutateAsync({
        versionId: version.id,
        ...changes,
        customerId: changes.customerId ?? undefined,
      })
      .then(
        () => {
          failures.current = 0;
          return true;
        },
        (error) => {
          // Refused changes wait for the next save, under anything newer, so
          // a header field is not lost while the screen still shows it.
          pending.current = { ...changes, ...pending.current };
          failures.current += 1;

          const decision = planRetry(error, failures.current);
          if (decision.retry && alive.current) {
            // Send them again on a timer rather than waiting for a keystroke
            // that may never come — the silence is what FF-1648 is about.
            if (timer.current) clearTimeout(timer.current);
            timer.current = setTimeout(() => retry.current(), decision.delayMs);
          } else {
            // Out of attempts, or refused for a reason the same payload will
            // earn again. Say so, and let the next edit start over.
            failures.current = 0;
            notSaved.current(error as { message: string });
          }
          return false;
        },
      );
  }, [save.mutateAsync, version.id]);

  useEffect(() => {
    notSaved.current = errorToast("Not saved");
    retry.current = flush;
  });

  /**
   * Saves what is waiting and resolves once every save has landed: true when
   * the server holds exactly what the screen shows. Sending waits on it, as
   * the version is priced from what is stored.
   */
  const saved = useCallback(async () => {
    flush();
    const ok = await lastSave.current;
    return ok && Object.keys(pending.current).length === 0;
  }, [flush]);

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
    alive.current = true;
    const warn = (event: BeforeUnloadEvent) => {
      if (Object.keys(pending.current).length > 0) {
        flush();
        event.preventDefault();
      }
    };
    window.addEventListener("beforeunload", warn);
    return () => {
      alive.current = false;
      window.removeEventListener("beforeunload", warn);
      flush();
    };
  }, [flush]);

  return { draft, change, saved };
}
