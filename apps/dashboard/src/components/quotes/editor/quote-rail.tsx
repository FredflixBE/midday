"use client";

import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@midday/ui/accordion";
import { type CSSProperties, type ReactNode, useState } from "react";

/**
 * How tall the strip that stays on screen stands (FF-1631), set on the page
 * by the editor and read here: the rail sticks below the strip, and the strip
 * is a line taller on a quote that has been accepted or answered.
 */
export const STRIP_HEIGHT = "--quote-strip-height";

/**
 * Where the rail comes to rest: under the strip, a gap below it. The fallback
 * is the strip at its shorter height, for the frame before it is measured.
 */
const RAIL_TOP = `calc(var(${STRIP_HEIGHT}, 73px) + 1.5rem)`;

/**
 * The settings rail (FF-1630): everything that configures a quote rather than
 * composes it, beside the document instead of running down the same column.
 * It follows the page on a wide window and sits under the document on a
 * narrow one — where it is not sticky, so neither the offset nor the height
 * it implies applies.
 */
export function QuoteRail({ children }: { children: ReactNode }) {
  return (
    // Nothing scrolls sideways: a section opening a pixel wider than the rail
    // would otherwise flash a horizontal scrollbar across the whole column,
    // because `overflow-y: auto` alone makes the other axis `auto` too.
    <aside
      className="min-w-0 xl:sticky xl:top-[var(--rail-top)] xl:max-h-[calc(100vh_-_var(--rail-top)_-_1.5rem)] xl:w-[380px] xl:shrink-0 xl:overflow-y-auto xl:overflow-x-hidden"
      style={{ "--rail-top": RAIL_TOP } as CSSProperties}
    >
      {children}
    </aside>
  );
}

/** The rail's collapsible settings, under everything it keeps in view. */
export function RailSections({ children }: { children: ReactNode }) {
  return <div className="border-t border-border">{children}</div>;
}

/**
 * What the rail keeps in view rather than tucks into a section: the totals of
 * the scenario on show (FF-1632). It stays put while the rail is scrolled,
 * so a figure never leaves the screen while the line that moves it is being
 * changed.
 */
export function RailCard({
  title,
  children,
}: {
  title?: string;
  children: ReactNode;
}) {
  return (
    // Sticky only where the rail is itself a scrolling column; stacked under
    // the document it is just the first thing in the rail.
    <div className="bg-background pb-5 xl:sticky xl:top-0 xl:z-10">
      {title ? (
        <div className="truncate pb-2 text-[12px] text-[#606060]">{title}</div>
      ) : null}
      {children}
    </div>
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
