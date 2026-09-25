import { isDateInFutureUTC } from "@midday/invoice/recurring";
import { Button } from "@midday/ui/button";
import { Icons } from "@midday/ui/icons";
import { ScrollArea } from "@midday/ui/scroll-area";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@midday/ui/tooltip";
import { useToast } from "@midday/ui/use-toast";
import {
  useIsMutating,
  useMutation,
  useQueryClient,
} from "@tanstack/react-query";
import { differenceInDays } from "date-fns";
import { useFormContext, useWatch } from "react-hook-form";
import { useInvoiceParams } from "@/hooks/use-invoice-params";
import { useUserQuery } from "@/hooks/use-user";
import { useTRPC } from "@/trpc/client";
import { getUrl } from "@/utils/environment";
import { CustomerDetails } from "./customer-details";
import { DraftAutoSave } from "./draft-auto-save";
import { EditBlock } from "./edit-block";
import { EmailPreview } from "./email-preview";
import type { InvoiceFormValues } from "./form-context";
import { FromDetails } from "./from-details";
import { LineItems } from "./line-items";
import { Logo } from "./logo";
import { Meta } from "./meta";
import { NoteDetails } from "./note-details";
import { PaymentDetails } from "./payment-details";
import { SettingsMenu } from "./settings-menu";
import { SubmitButton } from "./submit-button";
import { Summary } from "./summary";
import { TemplateSelector } from "./template-selector";

export function Form() {
  const { setParams } = useInvoiceParams();
  const { data: user } = useUserQuery();

  const form = useFormContext();
  const token = useWatch({ control: form.control, name: "token" });
  const deliveryType = useWatch({
    control: form.control,
    name: "template.deliveryType",
  });

  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  // DraftAutoSave owns the draft mutation; the submit button waits for it.
  const isSavingDraft =
    useIsMutating({ mutationKey: trpc.invoice.draft.mutationKey() }) > 0;

  const createInvoiceMutation = useMutation(
    trpc.invoice.create.mutationOptions({
      onSuccess: (data) => {
        queryClient.invalidateQueries({
          queryKey: trpc.invoice.get.infiniteQueryKey(),
        });

        queryClient.invalidateQueries({
          queryKey: trpc.invoice.getById.queryKey(),
        });

        queryClient.invalidateQueries({
          queryKey: trpc.invoice.invoiceSummary.queryKey(),
        });

        queryClient.invalidateQueries({
          queryKey: trpc.invoice.paymentStatus.queryKey(),
        });

        // Invalidate global search
        queryClient.invalidateQueries({
          queryKey: trpc.search.global.queryKey(),
        });

        // Next suggested invoice number must advance after a successful send;
        // otherwise "Create another" resets from stale defaultSettings and shows
        // a duplicate-number validation error.
        queryClient.invalidateQueries({
          queryKey: trpc.invoice.defaultSettings.queryKey(),
        });

        setParams({ invoiceType: "success", invoiceId: data.id });
      },
      onError: (error) => {
        // Check if this is a scheduling error using the specific error code
        if (error.data?.code === "SERVICE_UNAVAILABLE") {
          toast({
            title: "Scheduling Failed",
            description:
              "Please try again. If the issue persists, contact support.",
          });
        } else {
          // Generic error handling for other invoice creation errors
          toast({
            title: "Invoice Creation Failed",
            description: "An unexpected error occurred. Please try again.",
          });
        }
      },
    }),
  );

  const createRecurringInvoiceMutation = useMutation(
    trpc.invoiceRecurring.create.mutationOptions({
      onSuccess: () => {
        // Invalidate queries - the form will be closed by createInvoiceMutation
        queryClient.invalidateQueries({
          queryKey: trpc.invoice.get.infiniteQueryKey(),
        });

        queryClient.invalidateQueries({
          queryKey: trpc.invoiceRecurring.list.queryKey(),
        });

        queryClient.invalidateQueries({
          queryKey: trpc.invoice.invoiceSummary.queryKey(),
        });

        // Invalidate global search
        queryClient.invalidateQueries({
          queryKey: trpc.search.global.queryKey(),
        });

        // Don't show toast or close form here - createInvoiceMutation will handle that
      },
      onError: (_error) => {
        toast({
          title: "Recurring Invoice Failed",
          description: "An unexpected error occurred. Please try again.",
        });
      },
    }),
  );

  // Mutation to update invoice status (used for scheduling future-dated recurring invoices)
  const updateInvoiceMutation = useMutation(
    trpc.invoice.update.mutationOptions({
      onError: () => {
        toast({
          title: "Scheduling Failed",
          description:
            "The recurring series was created, but the invoice could not be scheduled. Please try again.",
        });
      },
    }),
  );

  // Submit the form and the draft invoice
  const handleSubmit = async (values: InvoiceFormValues) => {
    // Handle recurring invoices differently
    if (
      values.template.deliveryType === "recurring" &&
      values.recurringConfig
    ) {
      const config = values.recurringConfig;

      // Calculate due date offset from issue date to due date
      const issueDate = new Date(values.issueDate);
      const dueDate = new Date(values.dueDate);
      const dueDateOffset = differenceInDays(dueDate, issueDate);

      // Remove deliveryType from template since recurring is handled differently
      const { deliveryType: _, ...templateWithoutDeliveryType } =
        values.template;

      try {
        // First create the recurring series and link the draft invoice
        const recurringResult =
          await createRecurringInvoiceMutation.mutateAsync({
            invoiceId: values.id, // Link the draft invoice to the recurring series
            customerId: values.customerId,
            customerName: values.customerName ?? undefined,
            frequency: config.frequency,
            frequencyDay: config.frequencyDay,
            frequencyWeek: config.frequencyWeek,
            frequencyInterval: config.frequencyInterval,
            endType: config.endType ?? "never",
            endDate: config.endDate,
            endCount: config.endCount,
            timezone:
              user?.timezone ||
              Intl.DateTimeFormat().resolvedOptions().timeZone,
            dueDateOffset: dueDateOffset >= 0 ? dueDateOffset : 30,
            amount: values.amount,
            currency: values.template.currency,
            lineItems: values.lineItems,
            template: {
              ...templateWithoutDeliveryType,
              deliveryType: "create_and_send" as const, // Recurring invoices are sent automatically
            },
            templateId: values.template.id, // Save the template reference
            paymentDetails: values.paymentDetails,
            fromDetails: values.fromDetails,
            noteDetails: values.noteDetails,
            vat: values.vat,
            tax: values.tax,
            discount: values.discount,
            subtotal: values.subtotal,
            topBlock: values.topBlock,
            bottomBlock: values.bottomBlock,
          });

        // Update form state with the recurring series ID to prevent duplicate series
        // if the send fails and user retries
        if (recurringResult?.id) {
          form.setValue("invoiceRecurringId", recurringResult.id);
        }

        // Check if issue date is in the future (at the UTC day level)
        // If so, don't send the invoice immediately - the scheduler will handle it
        // Using isDateInFutureUTC ensures consistent behavior with the backend
        const isIssueDateFuture = isDateInFutureUTC(issueDate);

        if (isIssueDateFuture) {
          // Future-dated recurring invoice:
          // - Set status to "scheduled" so user understands it will be sent later
          // - Set scheduledAt to the issue date for consistency with the status tooltip
          // - The scheduler will send it on the issue date
          // - Navigate to success page
          await updateInvoiceMutation.mutateAsync({
            id: values.id,
            status: "scheduled",
            scheduledAt: issueDate.toISOString(),
          });

          queryClient.invalidateQueries({
            queryKey: trpc.invoice.get.infiniteQueryKey(),
          });
          queryClient.invalidateQueries({
            queryKey: trpc.invoice.invoiceSummary.queryKey(),
          });
          queryClient.invalidateQueries({
            queryKey: trpc.invoice.defaultSettings.queryKey(),
          });
          setParams({ invoiceType: "success", invoiceId: values.id });
        } else {
          // Issue date is today or in the past - send immediately
          createInvoiceMutation.mutate({
            id: values.id,
            deliveryType: "create_and_send",
          });
        }
      } catch {
        // Errors are handled by each mutation's onError handler
        // - createRecurringInvoiceMutation.onError shows "Recurring Invoice Failed"
        // - updateInvoiceMutation.onError shows "Scheduling Failed"
      }
      return;
    }

    // Handle regular invoice creation
    const deliveryType = values.template.deliveryType;
    createInvoiceMutation.mutate({
      id: values.id,
      deliveryType:
        deliveryType === "recurring" ? "create" : (deliveryType ?? "create"),
      scheduledAt: values.scheduledAt || undefined,
    });
  };

  // Prevent form from submitting when pressing enter, but allow newlines in textareas
  const handleKeyDown = (e: React.KeyboardEvent<HTMLFormElement>) => {
    if (e.key === "Enter" && !(e.target instanceof HTMLTextAreaElement)) {
      e.preventDefault();
    }
  };

  return (
    <form
      // @ts-expect-error
      onSubmit={form.handleSubmit(handleSubmit)}
      className="relative h-full"
      onKeyDown={handleKeyDown}
    >
      <ScrollArea
        className="h-[calc(100vh-110px)] p-6 [&>div>div]:h-full"
        hideScrollbar
      >
        <div className="p-8 pb-4 h-full flex flex-col bg-[#fcfcfc] dark:bg-[#0f0f0f]">
          <div className="flex justify-between items-start">
            <div className="flex-1 min-w-0 mr-5">
              <Meta />
            </div>
            <div className="shrink-0">
              <Logo />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-6 mt-8 mb-4">
            <div>
              <FromDetails />
            </div>
            <div>
              <CustomerDetails />
            </div>
          </div>

          <EditBlock name="topBlock" />

          <div className="mt-4">
            <LineItems />
          </div>

          <div className="mt-12 flex justify-end mb-8">
            <Summary />
          </div>

          <div className="flex flex-col mt-auto">
            <div className="grid grid-cols-2 gap-6 mb-4 overflow-hidden">
              <PaymentDetails />
              <NoteDetails />
            </div>

            <EditBlock name="bottomBlock" />
          </div>
        </div>

        <DraftAutoSave />
      </ScrollArea>

      <div className="absolute bottom-4 w-full border-t border-border pt-4 px-6">
        <div className="flex flex-col gap-3">
          <div className="flex justify-between items-center">
            <div className="flex gap-2">
              <SettingsMenu />
              <TemplateSelector />
            </div>

            <div className="flex gap-2">
              <TooltipProvider delayDuration={100}>
                {deliveryType === "create_and_send" && (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        variant="outline"
                        size="icon"
                        type="button"
                        onClick={() => setParams({ emailPreview: true })}
                      >
                        <Icons.ForwardToInbox className="size-3" />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent
                      side="top"
                      sideOffset={8}
                      className="text-[10px] px-2 py-1"
                    >
                      Preview email
                    </TooltipContent>
                  </Tooltip>
                )}

                {token && (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        variant="outline"
                        size="icon"
                        type="button"
                        onClick={() => {
                          window.open(`${getUrl()}/i/${token}`, "_blank");
                        }}
                      >
                        <Icons.ExternalLink className="size-3" />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent
                      side="top"
                      sideOffset={8}
                      className="text-[10px] px-2 py-1"
                    >
                      Preview invoice
                    </TooltipContent>
                  </Tooltip>
                )}
              </TooltipProvider>

              <SubmitButton
                isSubmitting={
                  createInvoiceMutation.isPending ||
                  createRecurringInvoiceMutation.isPending
                }
                disabled={
                  createInvoiceMutation.isPending ||
                  createRecurringInvoiceMutation.isPending ||
                  isSavingDraft
                }
                className={
                  isSavingDraft
                    ? "disabled:opacity-100 disabled:cursor-wait"
                    : undefined
                }
              />
            </div>
          </div>
        </div>
      </div>
      <EmailPreview />
    </form>
  );
}
