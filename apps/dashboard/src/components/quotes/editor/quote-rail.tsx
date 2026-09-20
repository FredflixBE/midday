"use client";

import { cn } from "@midday/ui/cn";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@midday/ui/collapsible";
import { ChevronDown } from "lucide-react";
import { type ReactNode, useState } from "react";

/**
 * The settings rail (FF-1630): everything that configures a quote rather than
 * composes it, beside the document instead of running down the same column.
 * It follows the page on a wide window and sits under the document on a
 * narrow one.
 */
export function QuoteRail({ children }: { children: ReactNode }) {
  return (
    <aside className="min-w-0 xl:sticky xl:top-6 xl:max-h-[calc(100vh-3rem)] xl:w-[380px] xl:shrink-0 xl:overflow-y-auto">
      <div className="border-t border-border">{children}</div>
    </aside>
  );
}

/**
 * One collapsible group of settings. `filled` is what the section holds
 * today: an empty one opens as a single line rather than an empty table,
 * and follows its content until someone opens or closes it by hand.
 *
 * The trigger sits outside whatever `children` disables, so a sent version's
 * rail still opens and closes (the trap FF-1624 hit: a disabled fieldset
 * disables every button inside it).
 */
export function RailSection({
  title,
  filled = true,
  children,
}: {
  title: string;
  filled?: boolean;
  children: ReactNode;
}) {
  const [toggled, setToggled] = useState<boolean>();
  const open = toggled ?? filled;

  return (
    <Collapsible
      open={open}
      onOpenChange={setToggled}
      className="border-b border-border"
    >
      <CollapsibleTrigger className="flex w-full items-center justify-between gap-2 py-3 text-left">
        <span className="text-sm font-medium">{title}</span>
        <ChevronDown
          size={14}
          className={cn(
            "shrink-0 text-[#878787] transition-transform",
            open && "rotate-180",
          )}
        />
      </CollapsibleTrigger>
      <CollapsibleContent className="pb-5">{children}</CollapsibleContent>
    </Collapsible>
  );
}
