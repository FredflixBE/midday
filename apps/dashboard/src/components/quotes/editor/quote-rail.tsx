"use client";

import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@midday/ui/accordion";
import { type ReactNode, useState } from "react";

/**
 * The settings rail (FF-1630): everything that configures a quote rather than
 * composes it, beside the document instead of running down the same column.
 * It follows the page on a wide window and sits under the document on a
 * narrow one.
 */
export function QuoteRail({ children }: { children: ReactNode }) {
  return (
    // Nothing scrolls sideways here: a section opening a pixel wider than the
    // rail would otherwise flash a horizontal scrollbar across the whole
    // column, because `overflow-y: auto` alone makes the other axis `auto`
    // too.
    <aside className="min-w-0 xl:sticky xl:top-6 xl:max-h-[calc(100vh-3rem)] xl:w-[380px] xl:shrink-0 xl:overflow-y-auto xl:overflow-x-hidden">
      <div className="border-t border-border">{children}</div>
    </aside>
  );
}

/**
 * One collapsible group of settings, with its fields disabled on a version
 * that cannot be edited. A section with nothing to show is not drawn at all —
 * that is the caller's call, since only the caller knows whether an empty
 * section still has something to add.
 *
 * `filled` is what the section holds: an empty one starts as a single line
 * rather than an open one, and opens by itself once something lands in it —
 * including content that arrives after the first render, such as the rates of
 * products still being read. Emptying a section never shuts it, so removing
 * the last tier does not take the Add button out from under the cursor.
 *
 * The trigger sits outside the fieldset, which is the trap FF-1624 hit: a
 * disabled fieldset disables every button inside it, so a sent version's rail
 * would no longer open.
 */
export function RailSection({
  title,
  filled = true,
  disabled = false,
  children,
}: {
  title: string;
  filled?: boolean;
  disabled?: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(filled);
  const [wasFilled, setWasFilled] = useState(filled);

  if (filled && !wasFilled) {
    setWasFilled(true);
    setOpen(true);
  }

  // The shared accordion, so a section opens the way every other one in the
  // dashboard does: clipped while it moves, over the same fifth of a second.
  return (
    <Accordion
      type="single"
      collapsible
      value={open ? title : ""}
      onValueChange={(value) => setOpen(value === title)}
    >
      <AccordionItem value={title}>
        <AccordionTrigger className="py-3 text-sm">{title}</AccordionTrigger>
        <AccordionContent>
          <fieldset disabled={disabled} className="min-w-0">
            {children}
          </fieldset>
        </AccordionContent>
      </AccordionItem>
    </Accordion>
  );
}
