"use client";

import { cn } from "@midday/ui/cn";
import { Tabs, TabsList, TabsTrigger } from "@midday/ui/tabs";
import { useQuery } from "@tanstack/react-query";
import { useQueryState } from "nuqs";
import { startTransition } from "react";
import { useTRPC } from "@/trpc/client";

/**
 * How much is left in the inbox's own inbox-zero view (FF-1499). It counts
 * document groups rather than rows, so a copy the pull filed against an
 * original is not a second thing to do.
 */
function NeedsHandlingCount() {
  const trpc = useTRPC();
  const { data } = useQuery(trpc.inbox.needsHandlingCount.queryOptions());

  if (!data) {
    return null;
  }

  return <span className="ml-1 text-xs text-muted-foreground">({data})</span>;
}

export function InboxTabs() {
  const [currentTab, setTab] = useQueryState("tab", {
    defaultValue: "all",
    startTransition,
  });

  return (
    <Tabs value={currentTab ?? "all"} onValueChange={setTab}>
      <div className="relative flex items-stretch bg-muted w-fit">
        <TabsList className="flex items-stretch h-auto p-0 bg-transparent">
          <TabsTrigger
            value="all"
            className={cn(
              "group relative flex items-center gap-1.5 px-3 py-1.5 text-[14px] transition-all whitespace-nowrap border border-transparent h-[34px] min-h-[34px]",
              "text-muted-foreground hover:text-foreground bg-muted mb-0 relative z-[1]",
              "data-[state=active]:text-foreground data-[state=active]:bg-background data-[state=active]:mb-[-1px] data-[state=active]:z-10",
            )}
          >
            All
          </TabsTrigger>
          <TabsTrigger
            value="needs_handling"
            className={cn(
              "group relative flex items-center gap-1.5 px-3 py-1.5 text-[14px] transition-all whitespace-nowrap border border-transparent h-[34px] min-h-[34px]",
              "text-muted-foreground hover:text-foreground bg-muted mb-0 relative z-[1]",
              "data-[state=active]:text-foreground data-[state=active]:bg-background data-[state=active]:mb-[-1px] data-[state=active]:z-10",
            )}
          >
            Needs handling
            <NeedsHandlingCount />
          </TabsTrigger>
          <TabsTrigger
            value="other"
            className={cn(
              "group relative flex items-center gap-1.5 px-3 py-1.5 text-[14px] transition-all whitespace-nowrap border border-transparent h-[34px] min-h-[34px]",
              "text-muted-foreground hover:text-foreground bg-muted mb-0 relative z-[1]",
              "data-[state=active]:text-foreground data-[state=active]:bg-background data-[state=active]:mb-[-1px] data-[state=active]:z-10",
            )}
          >
            Other
          </TabsTrigger>
        </TabsList>
      </div>
    </Tabs>
  );
}
