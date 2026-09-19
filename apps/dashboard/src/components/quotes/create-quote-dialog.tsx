"use client";

import type { QuoteKind } from "@midday/quote";
import { Button } from "@midday/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@midday/ui/dialog";
import { Input } from "@midday/ui/input";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { parseAsBoolean, useQueryState } from "nuqs";
import { useState } from "react";
import { SearchCustomers } from "@/components/search-customers";
import { useCustomerParams } from "@/hooks/use-customer-params";
import { useTRPC } from "@/trpc/client";
import {
  Field,
  KIND_LABELS,
  LANGUAGE_LABELS,
  OptionSelect,
} from "./editor/fields";
import { useErrorToast } from "./use-error-toast";

/**
 * `?createQuote=true` opens it, as the sidebar's Create new does. Not
 * `create`: the tracker's Create Project sheet listens for that on every page.
 */
export function useCreateQuoteParam() {
  return useQueryState("createQuote", parseAsBoolean.withDefault(false));
}

/**
 * A new quote: who it is for and what it is. It opens in the editor as
 * version 1, a draft.
 */
export function CreateQuoteDialog() {
  const trpc = useTRPC();
  const router = useRouter();
  const queryClient = useQueryClient();
  const errorToast = useErrorToast();
  const { setParams: setCustomerParams } = useCustomerParams();
  const [open, setOpen] = useCreateQuoteParam();

  const [customerId, setCustomerId] = useState<string>();
  const [title, setTitle] = useState("");
  const [kind, setKind] = useState<QuoteKind>("project");
  const [language, setLanguage] = useState<"nl" | "en">("nl");

  const create = useMutation(
    trpc.quotes.create.mutationOptions({
      onSuccess: (quote) => {
        queryClient.setQueryData(
          trpc.quotes.get.queryKey({ id: quote.id }),
          quote,
        );
        router.push(`/quotes/${quote.id}`);
      },
      onError: errorToast("Not created"),
    }),
  );

  const canCreate = customerId !== undefined && title.trim().length > 0;

  return (
    <Dialog open={open} onOpenChange={(next) => setOpen(next || null)}>
      <DialogContent className="max-w-[480px]">
        <form
          className="space-y-6 p-4"
          onSubmit={(event) => {
            event.preventDefault();
            if (!canCreate) return;
            create.mutate({ customerId, title: title.trim(), kind, language });
          }}
        >
          <DialogHeader>
            <DialogTitle>New quote</DialogTitle>
          </DialogHeader>

          <div className="space-y-4">
            <Field label="Customer">
              <SearchCustomers
                selectedId={customerId}
                onSelect={setCustomerId}
                onCreate={(name) =>
                  setCustomerParams({ createCustomer: true, name })
                }
                onEdit={(id) => setCustomerParams({ customerId: id })}
              />
            </Field>
            <Field label="Title">
              <Input
                aria-label="Title"
                value={title}
                maxLength={300}
                onChange={(e) => setTitle(e.target.value)}
              />
            </Field>
            <div className="grid grid-cols-2 gap-4">
              <Field label="Kind">
                <OptionSelect
                  aria-label="Kind"
                  value={kind}
                  options={KIND_LABELS}
                  onChange={setKind}
                />
              </Field>
              <Field label="Language">
                <OptionSelect
                  aria-label="Language"
                  value={language}
                  options={LANGUAGE_LABELS}
                  onChange={setLanguage}
                />
              </Field>
            </div>
          </div>

          <DialogFooter>
            <Button type="submit" disabled={!canCreate || create.isPending}>
              Create
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
