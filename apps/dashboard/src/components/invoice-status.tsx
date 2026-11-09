"use client";

import { cn } from "@midday/ui/cn";
import { Skeleton } from "@midday/ui/skeleton";
import { useI18n } from "@/locales/client";

export function InvoiceStatus({
  status,
  isLoading,
  className,
  textOnly = false,
}: {
  status?:
    | "draft"
    | "overdue"
    | "paid"
    | "unpaid"
    | "canceled"
    | "scheduled"
    | "refunded";
  isLoading?: boolean;
  className?: string;
  textOnly?: boolean;
}) {
  const t = useI18n();

  if (isLoading) {
    return <Skeleton className="w-24 h-6 rounded-full" />;
  }

  if (!status) {
    return null;
  }

  // Text-only mode for PDF rendering
  if (textOnly) {
    return (
      <span
        className={cn(
          (status === "draft" || status === "canceled") &&
            "text-muted-foreground",
          status === "overdue" && "text-warning",
          status === "paid" && "text-success",
          status === "unpaid" && "text-foreground",
          status === "scheduled" && "text-[#1F6FEB] dark:text-[#1F6FEB]",
          status === "refunded" && "text-[#F97316] dark:text-[#F97316]",
          className,
        )}
      >
        {t(`invoice_status.${status}`)}
      </span>
    );
  }

  return (
    <div
      className={cn(
        "px-2 py-0.5 rounded-full cursor-default inline-flex max-w-full text-[11px]",
        (status === "draft" || status === "canceled") &&
          "text-muted-foreground bg-muted text-[10px]",
        status === "overdue" && "bg-warning/10 text-warning",
        status === "paid" && "text-success bg-success/10",
        status === "unpaid" && "text-foreground bg-muted",
        status === "scheduled" &&
          "text-[#1F6FEB] bg-[#DDEBFF] dark:text-[#1F6FEB] dark:bg-[#1F6FEB]/10",
        status === "refunded" &&
          "text-[#F97316] bg-[#FFEDD5] dark:text-[#F97316] dark:bg-[#F97316]/10",
        className,
      )}
    >
      <span className="line-clamp-1 truncate inline-block">
        {t(`invoice_status.${status}`)}
      </span>
    </div>
  );
}
