"use client";

import type { RouterOutputs } from "@api/trpc/routers/_app";
import { Icons } from "@midday/ui/icons";
import { Spinner } from "@midday/ui/spinner";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@midday/ui/tooltip";
import { getInboxFailureReason } from "@midday/utils/inbox-failure";

type Props = {
  item: RouterOutputs["inbox"]["get"]["data"][number];
};

export function InboxStatus({ item }: Props) {
  // Don't show status for processing items - let skeleton handle the visual feedback
  if (item.status === "processing" || item.status === "new") {
    return null;
  }

  if (item.status === "failed") {
    // A refusal the uploader can act on says why; anything else gets the
    // generic message, which only makes sense because retrying might work.
    const failureReason = getInboxFailureReason(item.meta);

    return (
      <TooltipProvider delayDuration={0}>
        <Tooltip>
          <TooltipTrigger asChild>
            <div className="flex space-x-1.5 items-center px-1.5 py-0.5 text-[10px] cursor-default border">
              <div className="w-1.5 h-1.5 bg-destructive rounded-full" />
              <span>Failed</span>
            </div>
          </TooltipTrigger>
          <TooltipContent sideOffset={10} className="text-xs max-w-[260px]">
            {failureReason ? (
              <p>{failureReason}</p>
            ) : (
              <p>
                We couldn't process this file — <br />
                try again from the menu
              </p>
            )}
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
    );
  }

  // Show status for "other" (non-financial) documents
  if (item.status === "other" || item.type === "other") {
    return (
      <TooltipProvider delayDuration={0}>
        <Tooltip>
          <TooltipTrigger asChild>
            <div className="flex space-x-1.5 items-center px-1.5 py-0.5 text-[10px] cursor-default border text-muted-foreground">
              <span>Document</span>
            </div>
          </TooltipTrigger>
          <TooltipContent sideOffset={10} className="text-xs">
            <p>
              This document isn't an invoice or receipt — <br />
              no transaction matching required
            </p>
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
    );
  }

  if (item.status === "analyzing") {
    return (
      <TooltipProvider delayDuration={0}>
        <Tooltip>
          <TooltipTrigger asChild>
            <div className="flex space-x-1 items-center p-1 text-[#878787] text-[10px] px-1.5 py-0.5 cursor-default border">
              <Spinner size={14} className="stroke-primary" />
              <span>Analyzing</span>
            </div>
          </TooltipTrigger>
          <TooltipContent sideOffset={10} className="text-xs">
            <p>
              We're reviewing the file and checking <br />
              for a matching transaction
            </p>
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
    );
  }

  if (item.status === "suggested_match") {
    return (
      <TooltipProvider delayDuration={0}>
        <Tooltip>
          <TooltipTrigger asChild>
            <div className="flex space-x-1.5 items-center px-1.5 py-0.5 text-[10px] cursor-default border">
              <div className="w-1.5 h-1.5 bg-[#FFD02B] rounded-full" />
              <span>Suggested match</span>
            </div>
          </TooltipTrigger>
          <TooltipContent sideOffset={10} className="text-xs">
            <p>
              We found a possible match — confirm <br />
              or dismiss it
            </p>
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
    );
  }

  // A document that charges nothing will never have a payment, so it will never
  // be matched — and "Pending", which promises we will keep looking, is a lie
  // about it. Free-tier and trial invoices are a standing category rather than
  // an oddity: 21 of 131 documents on the first real inbox, from suppliers that
  // are otherwise entirely legitimate.
  //
  // Read from the status, not from `amount === 0`. Rendering it off the amount
  // made the badge say one thing while the row still said "pending" underneath,
  // so it appeared under the Pending filter and under no filter of its own.
  if (item.status === "no_charge") {
    return (
      <TooltipProvider delayDuration={0}>
        <Tooltip>
          <TooltipTrigger asChild>
            <div className="p-1 text-[10px] px-1.5 py-0.5 cursor-default inline-block border text-[#878787]">
              <span>No charge</span>
            </div>
          </TooltipTrigger>
          <TooltipContent sideOffset={10} className="text-xs">
            <p>
              This document charges nothing, so there is <br />
              no payment to match it to
            </p>
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
    );
  }

  if (item.status === "pending") {
    return (
      <TooltipProvider delayDuration={0}>
        <Tooltip>
          <TooltipTrigger asChild>
            <div className="p-1 text-[10px] px-1.5 py-0.5 cursor-default inline-block border">
              <span>Pending</span>
            </div>
          </TooltipTrigger>
          <TooltipContent sideOffset={10} className="text-xs">
            <p>
              We didn't find a match yet — we'll check <br />
              again when new transactions arrive
            </p>
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
    );
  }

  // Read from the transaction, not from the status. These two used to be the
  // same thing — `done` was only ever reached through `matchTransaction`, which
  // sets both — and the badge was written as `status === "done" || transactionId`
  // on that basis. FF-1450 gave `done` a second meaning: an invoice pulled from
  // the books is closed on arrival, because the accountant already has it and it
  // must not sit in the inbox looking like work. 200 such rows then claimed to
  // be "successfully matched to a transaction" while 82 of them had matched
  // nothing at all.
  if (item?.transactionId) {
    return (
      <TooltipProvider delayDuration={0}>
        <Tooltip>
          <TooltipTrigger asChild>
            <div className="flex space-x-1 items-center px-1.5 py-0.5 text-[10px] cursor-default border">
              <Icons.Check className="size-3.5 mt-[1px]" />
              <span>Matched</span>
            </div>
          </TooltipTrigger>
          <TooltipContent sideOffset={10} className="text-xs">
            <p>
              This file has been successfully <br />
              matched to a transaction
            </p>
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
    );
  }

  // Closed, with nothing attached. Today that is an invoice pulled from the
  // books, and the sentence says only what is true of any such row: it is dealt
  // with, and no transaction hangs off it. It deliberately does not name the
  // accounting system — FF-1499's rule is that no status may.
  if (item.status === "done") {
    return (
      <TooltipProvider delayDuration={0}>
        <Tooltip>
          <TooltipTrigger asChild>
            <div className="flex space-x-1.5 items-center px-1.5 py-0.5 text-[10px] cursor-default border text-[#878787]">
              <span>Filed</span>
            </div>
          </TooltipTrigger>
          <TooltipContent sideOffset={10} className="text-xs max-w-[260px]">
            <p>
              Dealt with, so nothing here is waiting on you. No transaction is
              attached to it.
            </p>
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
    );
  }

  return (
    <TooltipProvider delayDuration={0}>
      <Tooltip>
        <TooltipTrigger asChild>
          <div className="flex space-x-1 items-center px-1.5 py-0.5 text-[10px] cursor-default border">
            <span>No match</span>
          </div>
        </TooltipTrigger>
        <TooltipContent sideOffset={10} className="text-xs">
          <p>
            We couldn't find a match — please <br />
            select the transaction manually
          </p>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
