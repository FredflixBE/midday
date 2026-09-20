"use client";

import { withKind } from "@midday/quote";
import { Input } from "@midday/ui/input";
import { useEffect, useState } from "react";
import { SearchCustomers } from "@/components/search-customers";
import { useCustomerParams } from "@/hooks/use-customer-params";
import type { DraftChange, QuoteDraft } from "../use-quote-draft";
import {
  DateField,
  Field,
  KIND_LABELS,
  LANGUAGE_LABELS,
  MODE_LABELS,
  NumberInput,
  OptionSelect,
  UNIT_LABELS,
} from "./fields";

/**
 * The quote's title, which is part of the document and so stays in the main
 * column (FF-1630). It is the quote's and stays as sent, so a revision shows
 * it locked.
 */
export function QuoteTitleField({
  draft,
  change,
  locked,
}: {
  draft: QuoteDraft;
  change: (next: DraftChange) => void;
  locked: boolean;
}) {
  const [title, setTitle] = useState(draft.title);
  useEffect(() => setTitle(draft.title), [draft.title]);

  return (
    <Field label="Title">
      <Input
        aria-label="Title"
        value={title}
        maxLength={300}
        disabled={locked}
        onChange={(event) => {
          setTitle(event.target.value);
          // An empty title is refused; the last one stands until typed over.
          if (event.target.value.trim()) change({ title: event.target.value });
        }}
        onBlur={() => setTitle(draft.title)}
      />
    </Field>
  );
}

/**
 * Who the quote is for and what it is, in the settings rail (FF-1630).
 * Customer, kind and language are the quote's and stay as sent, so a
 * revision shows them locked. Hours or days, and the hours in a day, are the
 * version's (FF-1619).
 */
export function QuoteHeaderFields({
  draft,
  change,
  headerLocked,
  disabled,
}: {
  draft: QuoteDraft;
  change: (next: DraftChange) => void;
  headerLocked: boolean;
  disabled: boolean;
}) {
  const { setParams: setCustomerParams } = useCustomerParams();

  const locked = headerLocked || disabled;

  return (
    <div className="space-y-4">
      <Field label="Customer">
        <SearchCustomers
          selectedId={draft.customerId ?? undefined}
          onSelect={(customerId) => change({ customerId })}
          onCreate={(name) => setCustomerParams({ createCustomer: true, name })}
          onEdit={(customerId) => setCustomerParams({ customerId })}
          disabled={locked}
        />
      </Field>

      <div className="grid grid-cols-2 gap-x-4 gap-y-4">
        <Field label="Kind">
          <OptionSelect
            aria-label="Kind"
            value={draft.kind}
            options={KIND_LABELS}
            disabled={locked}
            // The scenarios change with the kind, in the same save.
            onChange={(kind) =>
              change((d) => ({ kind, content: withKind(d.content, kind) }))
            }
          />
        </Field>

        <Field label="Language">
          <OptionSelect
            aria-label="Language"
            value={draft.language}
            options={LANGUAGE_LABELS}
            disabled={locked}
            onChange={(language) => change({ language })}
          />
        </Field>

        <Field label="Mode">
          <OptionSelect
            aria-label="Mode"
            value={draft.mode}
            options={MODE_LABELS}
            disabled={disabled}
            onChange={(mode) => change({ mode })}
          />
        </Field>

        <Field label="Unit">
          <OptionSelect
            aria-label="Unit"
            value={draft.content.displayUnit}
            options={UNIT_LABELS}
            disabled={disabled}
            onChange={(displayUnit) =>
              change((d) => ({ content: { ...d.content, displayUnit } }))
            }
          />
        </Field>

        <Field label="Issued">
          <DateField
            aria-label="Issue date"
            value={draft.issueDate}
            onChange={(issueDate) =>
              change((d) => ({
                issueDate,
                // Never valid until before it is issued.
                validUntil: d.validUntil < issueDate ? issueDate : d.validUntil,
              }))
            }
          />
        </Field>

        <Field label="Valid until">
          <DateField
            aria-label="Valid until"
            value={draft.validUntil}
            disabledBefore={draft.issueDate}
            onChange={(validUntil) => change({ validUntil })}
          />
        </Field>

        {draft.content.displayUnit === "days" ? (
          <Field label="Hours per day">
            <NumberInput
              aria-label="Hours per day"
              value={draft.content.hoursPerDay}
              min={0.01}
              max={24}
              // Emptied, the quote keeps its hours per day.
              onChange={(hoursPerDay) =>
                hoursPerDay === null
                  ? undefined
                  : change((d) => ({ content: { ...d.content, hoursPerDay } }))
              }
            />
          </Field>
        ) : null}
      </div>
    </div>
  );
}
