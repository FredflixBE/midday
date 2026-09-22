"use client";

import type { RouterOutputs } from "@api/trpc/routers/_app";
import { Button } from "@midday/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
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
export function useRefreshQuote(quoteId: string) {
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
        setSentTo("");
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
 * reason; Reopen takes it back. Won comes from recording acceptance (FF-1615),
 * and Undo acceptance is the way out of one recorded by mistake (FF-1636) —
 * which is why the menu is still here on a won quote, where it used to
 * vanish and leave the row looking like it had lost its actions.
 */
export function OutcomeMenu({
  quoteId,
  outcome,
  acceptedVersionId,
}: {
  quoteId: string;
  outcome: RouterOutputs["quotes"]["get"]["outcome"];
  /** The version the acceptance was recorded on, when there is one. */
  acceptedVersionId?: string;
}) {
  const trpc = useTRPC();
  const errorToast = useErrorToast();
  const refresh = useRefreshQuote(quoteId);
  const [choice, setChoice] = useState<"lost" | "no_decision" | null>(null);
  const [undoing, setUndoing] = useState(false);
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

  const undoAcceptance = useMutation(
    trpc.quotes.undoAcceptance.mutationOptions({
      onSuccess: async () => {
        await refresh();
        setUndoing(false);
      },
      onError: errorToast("Not taken back"),
    }),
  );

  const won = outcome === "won";
  // Nothing to offer: won, but the accepted version is not this quote's.
  if (won && !acceptedVersionId) return null;

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button type="button" variant="outline">
            Outcome
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {won ? (
            <DropdownMenuItem onClick={() => setUndoing(true)}>
              Undo acceptance
            </DropdownMenuItem>
          ) : (
            <>
              <DropdownMenuItem onClick={() => setChoice("lost")}>
                Lost
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => setChoice("no_decision")}>
                No decision
              </DropdownMenuItem>
              {outcome !== "open" ? (
                <DropdownMenuItem
                  onClick={() =>
                    setOutcome.mutate({
                      quoteId,
                      outcome: "open",
                      reason: null,
                    })
                  }
                >
                  Reopen
                </DropdownMenuItem>
              ) : null}
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>

      <Dialog open={undoing} onOpenChange={setUndoing}>
        <DialogContent className="max-w-[420px]">
          <div className="space-y-6 p-4">
            <DialogHeader>
              <DialogTitle>Undo acceptance</DialogTitle>
              <DialogDescription>
                The quote goes back to open and the version back to sent. The
                project in the tracker is left as it is.
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => setUndoing(false)}
              >
                Cancel
              </Button>
              <Button
                type="button"
                disabled={undoAcceptance.isPending}
                onClick={() =>
                  acceptedVersionId &&
                  undoAcceptance.mutate({ versionId: acceptedVersionId })
                }
              >
                Undo acceptance
              </Button>
            </DialogFooter>
          </div>
        </DialogContent>
      </Dialog>

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
