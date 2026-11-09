import type * as React from "react";
import { cn } from "../utils";

function Skeleton({
  className,
  animate = true,
  ...props
}: React.HTMLAttributes<HTMLDivElement> & { animate?: boolean }) {
  return (
    <div
      className={cn(
        "relative overflow-hidden",
        "bg-linear-to-r from-transparent via-foreground/10 to-transparent",
        "bg-size-[200%_100%]",
        "rounded-none",
        animate && "animate-shimmer",
        className,
      )}
      {...props}
    />
  );
}

export { Skeleton };
