"use client";

import { cn } from "@midday/ui/cn";
import { Tabs, TabsList, TabsTrigger } from "@midday/ui/tabs";
import { useQueryState } from "nuqs";

export function AppsTabs() {
  const [currentTab, setTab] = useQueryState("tab", {
    defaultValue: "all",
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
              "data-[state=active]:text-foreground data-[state=active]:bg-accent data-[state=active]:mb-[-1px] data-[state=active]:z-10",
            )}
          >
            All
          </TabsTrigger>
          <TabsTrigger
            value="installed"
            className={cn(
              "group relative flex items-center gap-1.5 px-3 py-1.5 text-[14px] transition-all whitespace-nowrap border border-transparent h-[34px] min-h-[34px]",
              "text-muted-foreground hover:text-foreground bg-muted mb-0 relative z-[1]",
              "data-[state=active]:text-foreground data-[state=active]:bg-accent data-[state=active]:mb-[-1px] data-[state=active]:z-10",
            )}
          >
            Installed
          </TabsTrigger>
        </TabsList>
      </div>
    </Tabs>
  );
}
