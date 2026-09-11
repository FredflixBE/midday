"use client";

import { syncStartBounds } from "@midday/inbox/sync-start";
import { Button } from "@midday/ui/button";
import { Calendar } from "@midday/ui/calendar";
import { Icons } from "@midday/ui/icons";
import { Popover, PopoverContent, PopoverTrigger } from "@midday/ui/popover";
import { format, parse } from "date-fns";
import { useState } from "react";
import { useUserQuery } from "@/hooks/use-user";

const CALENDAR_DATE = "yyyy-MM-dd";

function toDate(value: string) {
  return parse(value, CALENDAR_DATE, new Date());
}

/**
 * The start date a new inbox connection is first synced from, as YYYY-MM-DD:
 * thirty days back until the user picks another.
 */
export function useSyncStart() {
  return useState(
    () => syncStartBounds(format(new Date(), CALENDAR_DATE)).suggested,
  );
}

type Props = {
  value: string;
  onChange: (value: string) => void;
};

/**
 * Pick how far back a new inbox connection is first synced, up to a year.
 * Every receipt found is read by a model, so the reach is the user's call.
 */
export function SyncStartPicker({ value, onChange }: Props) {
  const { data: user } = useUserQuery();
  const [isOpen, setIsOpen] = useState(false);

  const bounds = syncStartBounds(format(new Date(), CALENDAR_DATE));
  const earliest = toDate(bounds.earliest);
  const latest = toDate(bounds.latest);
  const selected = toDate(value);

  return (
    <div className="flex items-center justify-between gap-2">
      <span className="text-sm text-muted-foreground">Find receipts from</span>

      <Popover open={isOpen} onOpenChange={setIsOpen}>
        <PopoverTrigger asChild>
          <Button
            variant="outline"
            className="h-8 px-3 font-normal"
            data-track="Inbox Sync Start Opened"
          >
            {format(selected, user?.dateFormat ?? "MMM d, yyyy")}
            <Icons.ChevronDown className="size-4 ml-2 text-muted-foreground" />
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-auto p-0" align="end">
          <Calendar
            mode="single"
            captionLayout="dropdown"
            weekStartsOn={user?.weekStartsOnMonday ? 1 : 0}
            selected={selected}
            defaultMonth={selected}
            startMonth={earliest}
            endMonth={latest}
            disabled={[{ before: earliest }, { after: latest }]}
            onSelect={(date) => {
              if (date) {
                onChange(format(date, CALENDAR_DATE));
                setIsOpen(false);
              }
            }}
            required
          />
        </PopoverContent>
      </Popover>
    </div>
  );
}
