"use client";

import {
  useIsMutating,
  useMutation,
  useQueryClient,
} from "@tanstack/react-query";
import { useEffect } from "react";
import { useFormContext, useFormState, useWatch } from "react-hook-form";
import { useDebounceValue } from "usehooks-ts";
import { useInvoiceParams } from "@/hooks/use-invoice-params";
import { useInvoiceEditorStore } from "@/store/invoice-editor";
import { useTRPC } from "@/trpc/client";
import { SavingBar } from "../saving-bar";
import { transformFormValuesToDraft } from "./utils";

/**
 * Saves the invoice draft a moment after the last edit, and shows the saving
 * bar. It watches every field the draft carries, so it re-renders on every
 * keystroke; as its own component that re-render stays here instead of
 * running through the whole editor (FF-1715).
 */
export function DraftAutoSave() {
  const { invoiceId, setParams } = useInvoiceParams();
  const form = useFormContext();
  const trpc = useTRPC();
  const queryClient = useQueryClient();

  // Track in-flight template upsert mutations (fired by SettingsMenu, labels, etc.)
  // so the SavingBar reacts immediately instead of waiting for the 500ms debounce.
  const templateUpsertCount = useIsMutating({
    mutationKey: trpc.invoiceTemplate.upsert.mutationKey(),
  });

  const draftInvoiceMutation = useMutation(
    trpc.invoice.draft.mutationOptions({
      onSuccess: (data) => {
        if (!invoiceId && data?.id) {
          setParams({ invoiceType: "edit", invoiceId: data.id });
        }

        queryClient.invalidateQueries({
          queryKey: trpc.invoice.get.infiniteQueryKey(),
        });

        queryClient.invalidateQueries({
          queryKey: trpc.invoice.invoiceSummary.queryKey(),
        });
      },
    }),
  );

  // Mutation to update recurring series template when editing an invoice in a series
  const updateRecurringTemplateMutation = useMutation(
    trpc.invoiceRecurring.update.mutationOptions(),
  );

  // Only watch the fields that are used in the upsert action
  const formValues = useWatch({
    control: form.control,
    name: [
      "customerDetails",
      "customerId",
      "customerName",
      "template",
      "lineItems",
      "amount",
      "vat",
      "tax",
      "discount",
      "dueDate",
      "issueDate",
      "noteDetails",
      "paymentDetails",
      "fromDetails",
      "invoiceNumber",
      "topBlock",
      "bottomBlock",
      "scheduledAt",
      "recurringConfig",
      "invoiceRecurringId",
    ],
  });

  const { errors } = useFormState({
    control: form.control,
    name: "invoiceNumber",
  });
  const invoiceNumberValid = !errors.invoiceNumber;
  const [debouncedValue] = useDebounceValue(formValues, 500);

  // Auto-save: only save when form values have genuinely changed from what was loaded/last saved.
  // Uses a zustand snapshot store instead of isDirty (which is unreliable with computed fields).
  //
  // After each form.reset(), the store is marked as uninitialized. The first debounce tick
  // captures the fully hydrated state (after Summary and other child effects have settled)
  // as the baseline. Subsequent ticks compare against that baseline.
  useEffect(() => {
    const currentFormValues = form.getValues();
    const store = useInvoiceEditorStore.getState();

    // First debounce after a reset: capture the settled values as baseline, don't save
    if (!store.initialized) {
      store.initialize(currentFormValues);
      return;
    }

    if (!store.hasChanged(currentFormValues)) return;
    if (!currentFormValues.customerId || !invoiceNumberValid) return;

    // Serialize now — getValues() returns a shallow copy so nested objects
    // (e.g. template) are shared mutable refs into the form's internal state.
    // If the user edits a field between mutation start and onSuccess,
    // JSON.stringify would capture the unsaved mutation, causing the next
    // hasChanged() check to silently skip the save.
    const serialized = JSON.stringify(currentFormValues);

    // If invoice is part of a recurring series, both the draft AND the
    // recurring template must save successfully before we mark the snapshot
    // as saved. Otherwise a recurring-template failure would be masked by
    // the draft's onSuccess updating the snapshot, and hasChanged() would
    // return false on the next tick — silently dropping the retry.
    const { invoiceRecurringId } = currentFormValues;
    const needsRecurringUpdate = !!invoiceRecurringId;

    // Track which mutations have completed for this save cycle
    let draftOk = false;
    let recurringOk = !needsRecurringUpdate; // true when no recurring update needed

    const maybeCommitSnapshot = () => {
      if (draftOk && recurringOk) {
        store.setSnapshot(serialized);
      }
    };

    draftInvoiceMutation.mutate(
      // @ts-expect-error
      transformFormValuesToDraft(currentFormValues),
      {
        onSuccess: () => {
          draftOk = true;
          maybeCommitSnapshot();
        },
      },
    );

    if (needsRecurringUpdate) {
      // Remove deliveryType from template since "recurring" is not a valid API deliveryType
      const { deliveryType: _, ...templateWithoutDeliveryType } =
        currentFormValues.template;

      updateRecurringTemplateMutation.mutate(
        {
          id: invoiceRecurringId,
          lineItems: currentFormValues.lineItems,
          template: templateWithoutDeliveryType,
          paymentDetails: currentFormValues.paymentDetails,
          fromDetails: currentFormValues.fromDetails,
          noteDetails: currentFormValues.noteDetails,
          vat: currentFormValues.vat,
          tax: currentFormValues.tax,
          discount: currentFormValues.discount,
          subtotal: currentFormValues.subtotal,
          topBlock: currentFormValues.topBlock,
          bottomBlock: currentFormValues.bottomBlock,
          amount: currentFormValues.amount,
        },
        {
          onSuccess: () => {
            recurringOk = true;
            maybeCommitSnapshot();
          },
          // onError intentionally omitted — recurringOk stays false,
          // snapshot is never committed, and the next debounce tick retries.
        },
      );
    }
  }, [debouncedValue, invoiceNumberValid]);

  return (
    <SavingBar
      isPending={draftInvoiceMutation.isPending || templateUpsertCount > 0}
      isError={draftInvoiceMutation.isError}
    />
  );
}
