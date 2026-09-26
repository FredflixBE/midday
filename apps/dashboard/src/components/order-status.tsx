"use client";

import { cn } from "@midday/ui/cn";
import { Skeleton } from "@midday/ui/skeleton";

export function OrderStatus({
  status,
  isLoading,
  className,
}: {
  status?: string;
  isLoading?: boolean;
  className?: string;
}) {
  if (isLoading) {
    return <Skeleton className="w-24 h-6 rounded-full" />;
  }

  if (!status) {
    return null;
  }

  return (
    <div
      className={cn(
        "px-2 py-0.5 rounded-full cursor-default inline-flex max-w-full text-[11px]",
        status === "paid" && "text-success bg-success/10",
        status === "pending" && "bg-warning/10 text-warning",
        (status === "cancelled" || status === "canceled") &&
          "text-muted-foreground bg-muted text-[10px]",
        status === "failed" && "text-foreground bg-muted",
        status === "refunded" && "text-muted-foreground bg-muted text-[10px]",
        className,
      )}
    >
      <span className="line-clamp-1 truncate inline-block capitalize">
        {status}
      </span>
    </div>
  );
}
