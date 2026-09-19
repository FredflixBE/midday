"use client";

import { Button } from "@midday/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@midday/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@midday/ui/dropdown-menu";
import { Input } from "@midday/ui/input";
import { Textarea } from "@midday/ui/textarea";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useTRPC } from "@/trpc/client";
import { useErrorToast } from "../use-error-toast";
import { Field } from "./fields";

/** After a follow-up action, the quote and the list read again. */
function useRefreshQuote(quoteId: string) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  return () =>
    Promise.all([
      queryClient.invalidateQueries({
        queryKey: trpc.quotes.get.queryKey({ id: quoteId }),
      }),
      queryClient.invalidateQueries({ queryKey: trpc.quotes.list.queryKey() }),
    ]);
}

/**
 * Mark as sent (FF-1614). v1 sends the PDF by hand through Gmail; this
 * records that it went, and to whom. The version is saved first, then frozen
 * and priced as it stands.
 */
export function MarkSentButton({
  quoteId,
  versionId,
  saved,
}: {
  quoteId: string;
  versionId: string;
  /** Resolves true once every change on screen is stored. */
  saved: () => Promise<boolean>;
}) {
  const trpc = useTRPC();
  const errorToast = useErrorToast();
  const refresh = useRefreshQuote(quoteId);
  const [open, setOpen] = useState(false);
  const [sentTo, setSentTo] = useState("");
  const [saving, setSaving] = useState(false);

  const markSent = useMutation(
    trpc.quotes.markSent.mutationOptions({
      onSuccess: async () => {
        await refresh();
        setOpen(false);
      },
      onError: errorToast("Not marked as sent"),
    }),
  );

  const submit = async () => {
    setSaving(true);
    const ok = await saved().finally(() => setSaving(false));
    // A refused save has said why; what was stored is not what is shown.
    if (!ok) return;
    markSent.mutate({ versionId, sentTo: sentTo.trim() || null });
  };

  return (
    <>
      <Button type="button" onClick={() => setOpen(true)}>
        Mark as sent
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-[420px]">
          <form
            className="space-y-6 p-4"
            onSubmit={(event) => {
              event.preventDefault();
              void submit();
            }}
          >
            <DialogHeader>
              <DialogTitle>Mark as sent</DialogTitle>
            </DialogHeader>
            <Field label="Sent to">
              <Input
                aria-label="Sent to"
                placeholder="name@example.com"
                value={sentTo}
                maxLength={500}
                onChange={(e) => setSentTo(e.target.value)}
              />
            </Field>
            <DialogFooter>
              <Button type="submit" disabled={saving || markSent.isPending}>
                Mark as sent
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}

const OUTCOME_TITLES = { lost: "Lost", no_decision: "No decision" };

/**
 * The answer, when it is not a yes (FF-1614): lost, or no decision, with the
 * reason; Reopen takes it back. Won comes from recording acceptance (FF-1615).
 */
export function OutcomeMenu({
  quoteId,
  outcome,
}: {
  quoteId: string;
  outcome: "open" | "won" | "lost" | "no_decision";
}) {
  const trpc = useTRPC();
  const errorToast = useErrorToast();
  const refresh = useRefreshQuote(quoteId);
  const [choice, setChoice] = useState<"lost" | "no_decision" | null>(null);
  const [reason, setReason] = useState("");

  const setOutcome = useMutation(
    trpc.quotes.setOutcome.mutationOptions({
      onSuccess: async () => {
        await refresh();
        setChoice(null);
        setReason("");
      },
      onError: errorToast("Not recorded"),
    }),
  );

  if (outcome === "won") return null;

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button type="button" variant="outline">
            Outcome
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onClick={() => setChoice("lost")}>
            Lost
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => setChoice("no_decision")}>
            No decision
          </DropdownMenuItem>
          {outcome !== "open" ? (
            <DropdownMenuItem
              onClick={() =>
                setOutcome.mutate({ quoteId, outcome: "open", reason: null })
              }
            >
              Reopen
            </DropdownMenuItem>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>

      <Dialog
        open={choice !== null}
        onOpenChange={(next) => {
          if (!next) setChoice(null);
        }}
      >
        <DialogContent className="max-w-[420px]">
          <form
            className="space-y-6 p-4"
            onSubmit={(event) => {
              event.preventDefault();
              if (!choice) return;
              setOutcome.mutate({
                quoteId,
                outcome: choice,
                reason: reason.trim() || null,
              });
            }}
          >
            <DialogHeader>
              <DialogTitle>
                {choice ? OUTCOME_TITLES[choice] : null}
              </DialogTitle>
            </DialogHeader>
            <Field label="Reason">
              <Textarea
                aria-label="Reason"
                value={reason}
                maxLength={2000}
                rows={3}
                onChange={(e) => setReason(e.target.value)}
              />
            </Field>
            <DialogFooter>
              <Button type="submit" disabled={setOutcome.isPending}>
                Save
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}
