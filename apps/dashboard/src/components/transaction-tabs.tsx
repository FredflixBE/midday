"use client";

import { cn } from "@midday/ui/cn";
import { Tabs, TabsList, TabsTrigger } from "@midday/ui/tabs";
import { useEffect, useState } from "react";
import { useReviewCount } from "@/hooks/use-review-count";
import { useTransactionTab } from "@/hooks/use-transaction-tab";

function ReviewCount() {
  const { data: count = 0 } = useReviewCount();
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  if (!mounted || count === 0) {
    return null;
  }

  return <span className="ml-1 text-xs text-muted-foreground">({count})</span>;
}

export function TransactionTabs() {
  const { tab, setTab } = useTransactionTab();

  const handleValueChange = (value: string) => {
    if (value === "all" || value === "review") {
      setTab(value);
    }
  };

  return (
    <Tabs value={tab} onValueChange={handleValueChange}>
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
            value="review"
            className={cn(
              "group relative flex items-center gap-1.5 px-3 py-1.5 text-[14px] transition-all whitespace-nowrap border border-transparent h-[34px] min-h-[34px]",
              "text-muted-foreground hover:text-foreground bg-muted mb-0 relative z-[1]",
              "data-[state=active]:text-foreground data-[state=active]:bg-accent data-[state=active]:mb-[-1px] data-[state=active]:z-10",
            )}
          >
            Review
            <ReviewCount />
          </TabsTrigger>
        </TabsList>
      </div>
    </Tabs>
  );
}
