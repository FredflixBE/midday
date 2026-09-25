"use client";

import { isDesktopApp } from "@midday/desktop-client/platform";
import { cn } from "@midday/ui/cn";

export function OpenURL({
  href,
  children,
  className,
}: {
  href: string;
  children: React.ReactNode;
  className?: string;
}) {
  const handleOnClick = () => {
    if (isDesktopApp()) {
      // Loaded here so web pages do not ship the desktop APIs (FF-1725).
      import("@midday/desktop-client/core").then(({ openUrl }) =>
        openUrl(href),
      );
    } else {
      window.open(href, "_blank", "noopener,noreferrer");
    }
  };

  return (
    <span onClick={handleOnClick} className={cn("cursor-pointer", className)}>
      {children}
    </span>
  );
}
