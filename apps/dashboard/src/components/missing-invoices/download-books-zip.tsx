"use client";

import { Button } from "@midday/ui/button";
import { Calendar } from "@midday/ui/calendar";
import { Checkbox } from "@midday/ui/checkbox";
import { Icons } from "@midday/ui/icons";
import { Label } from "@midday/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "@midday/ui/popover";
import { useToast } from "@midday/ui/use-toast";
import { format, startOfYear } from "date-fns";
import { useState } from "react";
import type { DateRange } from "react-day-picker";
import { useDownloadBooksZip } from "@/hooks/use-download-books-zip";
import { useUserQuery } from "@/hooks/use-user";

/**
 * "Download as zip": every invoice Midday holds for the payments of a period,
 * laid out for the accountant (FF-1581).
 *
 * Here rather than under Export because it is how this list is finished for now:
 * until Midday delivers invoices to the books itself, the zip is the hand-over.
 */
export function DownloadBooksZip() {
  const { toast } = useToast();
  const { data: user } = useUserQuery();
  const { download, progress, isPending } = useDownloadBooksZip();
  const [open, setOpen] = useState(false);
  const [range, setRange] = useState<DateRange | undefined>({
    from: startOfYear(new Date()),
    to: new Date(),
  });
  const [leaveOutSettledCards, setLeaveOutSettledCards] = useState(false);

  const start = async () => {
    if (!range?.from || !range?.to) return;

    try {
      const result = await download({
        from: format(range.from, "yyyy-MM-dd"),
        to: format(range.to, "yyyy-MM-dd"),
        leaveOutSettledCards,
      });

      setOpen(false);

      toast({
        variant: result.failed > 0 ? "error" : "success",
        duration: 6000,
        title: `${result.included} ${result.included === 1 ? "file" : "files"} in the zip.`,
        description:
          result.failed > 0
            ? `${result.failed} could not be downloaded; _Not included.txt lists them.`
            : result.withoutInvoice > 0
              ? `${result.withoutInvoice} ${result.withoutInvoice === 1 ? "payment has" : "payments have"} no invoice yet; _Not included.txt lists them.`
              : undefined,
      });
    } catch (error) {
      toast({
        variant: "error",
        duration: 6000,
        title: "The zip could not be made.",
        description: error instanceof Error ? error.message : undefined,
      });
    }
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm" className="gap-2">
          <Icons.ArrowCoolDown className="size-4" />
          Download as zip
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-auto p-0">
        <Calendar
          mode="range"
          selected={range}
          onSelect={setRange}
          disabled={(date) => date > new Date()}
          defaultMonth={range?.from}
          weekStartsOn={user?.weekStartsOnMonday ? 1 : 0}
        />
        <div className="space-y-4 border-t border-border p-4">
          <div className="flex items-start gap-2">
            <Checkbox
              id="leave-out-settled-cards"
              checked={leaveOutSettledCards}
              onCheckedChange={(checked) =>
                setLeaveOutSettledCards(checked === true)
              }
            />
            <Label
              htmlFor="leave-out-settled-cards"
              className="text-sm font-normal leading-tight"
            >
              Leave out card payments already settled in the books
            </Label>
          </div>
          <p className="max-w-[260px] text-xs text-[#878787]">
            Every payment of the period with an invoice in Midday, a folder per
            supplier. Payments from a bank account carry nothing from the books,
            so they are always included.
          </p>
          <Button
            className="w-full"
            onClick={start}
            disabled={!range?.from || !range?.to || isPending}
          >
            {progress
              ? `Downloading ${progress.done} of ${progress.total}…`
              : "Download"}
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
