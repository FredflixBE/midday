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
import {
  type BooksZipProgress,
  type BooksZipResult,
  useDownloadBooksZip,
} from "@/hooks/use-download-books-zip";
import { useUserQuery } from "@/hooks/use-user";

/**
 * "Download as zip": every invoice Midday holds for the payments of a period,
 * laid out for the accountant (FF-1581).
 *
 * Here rather than under Export because it is how this list is finished for now:
 * until Midday delivers invoices to the books itself, the zip is the hand-over.
 */
/**
 * What the button says while it works — a number only once it is the number of
 * invoices the zip will hold. While checking there is nothing true to count:
 * those documents are candidates, and most are left out (FF-1583).
 */
function label(progress: BooksZipProgress): string {
  if (progress.phase === "packing") {
    return `Packing ${progress.invoices} ${progress.invoices === 1 ? "invoice" : "invoices"}…`;
  }
  return "Checking against the books…";
}

/** What the toast says under the count, or nothing when there is nothing to add. */
function describe(result: BooksZipResult): string | undefined {
  const notes = [
    result.failed > 0 && `${result.failed} could not be downloaded`,
    result.leftOut > 0 && `${result.leftOut} the books already have`,
    result.withoutInvoice > 0 &&
      `${result.withoutInvoice} ${result.withoutInvoice === 1 ? "payment has" : "payments have"} no invoice yet`,
  ].filter((note): note is string => note !== false);

  return notes.length > 0
    ? `Left out: ${notes.join(", ")}. _Not included.txt lists them.`
    : undefined;
}

export function DownloadBooksZip() {
  const { toast } = useToast();
  const { data: user } = useUserQuery();
  const { download, progress, isPending } = useDownloadBooksZip();
  const [open, setOpen] = useState(false);
  const [range, setRange] = useState<DateRange | undefined>({
    from: startOfYear(new Date()),
    to: new Date(),
  });
  // On by default: the zip is meant to be what the books still need. The first
  // real download handed over 131 files the day after they were uploaded to the
  // books, because nothing was left out (FF-1583).
  const [leaveOutWhatTheBooksHave, setLeaveOutWhatTheBooksHave] =
    useState(true);

  const start = async () => {
    if (!range?.from || !range?.to) return;

    try {
      const result = await download({
        from: format(range.from, "yyyy-MM-dd"),
        to: format(range.to, "yyyy-MM-dd"),
        leaveOutWhatTheBooksHave,
      });

      setOpen(false);

      toast({
        variant: result.failed > 0 ? "error" : "success",
        duration: 6000,
        title: `${result.included} ${result.included === 1 ? "invoice" : "invoices"} to upload.`,
        description: describe(result),
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
        {/*
         * As wide as the calendar above it and no wider: seven cells of
         * --cell-size plus its own p-3 on both sides. Without this the panel
         * is as wide as the longest line under it, which left the calendar
         * sitting in a third of a very wide popover.
         */}
        <div className="w-[calc(7*2rem+1.5rem)] space-y-3 border-t border-border p-3">
          <div className="flex items-start gap-2">
            <Checkbox
              id="leave-out-what-the-books-have"
              className="mt-0.5"
              checked={leaveOutWhatTheBooksHave}
              onCheckedChange={(checked) =>
                setLeaveOutWhatTheBooksHave(checked === true)
              }
            />
            <Label
              htmlFor="leave-out-what-the-books-have"
              className="text-xs font-normal leading-snug"
            >
              Leave out what the books already have
            </Label>
          </div>
          <p className="text-xs leading-snug text-muted-foreground">
            A folder per supplier, for every payment of the period with an
            invoice. Left out: invoices the books hold a copy of, and card
            payments they have settled. _Not included.txt lists both.
          </p>
          <Button
            className="w-full"
            onClick={start}
            disabled={!range?.from || !range?.to || isPending}
          >
            {progress ? label(progress) : "Download"}
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
