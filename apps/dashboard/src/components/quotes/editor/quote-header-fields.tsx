"use client";

import { withKind } from "@midday/quote";
import { Input } from "@midday/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@midday/ui/select";
import { useEffect, useState } from "react";
import { SearchCustomers } from "@/components/search-customers";
import { useCustomerParams } from "@/hooks/use-customer-params";
import type { DraftChange, QuoteDraft } from "../use-quote-draft";
import { DateField, Field } from "./fields";

export const KIND_LABELS = { project: "Project", recurring: "Recurring" };
export const MODE_LABELS = { estimate: "Estimate", firm: "Firm offer" };
export const LANGUAGE_LABELS = { nl: "Dutch", en: "English" };

export function OptionSelect<T extends string>({
  value,
  options,
  onChange,
  disabled,
  "aria-label": ariaLabel,
}: {
  value: T;
  options: Record<T, string>;
  onChange: (value: T) => void;
  disabled?: boolean;
  "aria-label"?: string;
}) {
  return (
    <Select
      value={value}
      onValueChange={(next) => onChange(next as T)}
      disabled={disabled}
    >
      <SelectTrigger aria-label={ariaLabel}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {(Object.keys(options) as T[]).map((key) => (
          <SelectItem key={key} value={key}>
            {options[key]}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/**
 * Who the quote is for and what it is. Customer, title, kind and language
 * are the quote's and stay as sent, so a revision shows them locked.
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
  const [title, setTitle] = useState(draft.title);
  useEffect(() => setTitle(draft.title), [draft.title]);

  const locked = headerLocked || disabled;

  return (
    <div className="grid grid-cols-2 gap-x-6 gap-y-4 md:grid-cols-4">
      <Field label="Customer" className="col-span-2">
        <SearchCustomers
          selectedId={draft.customerId ?? undefined}
          onSelect={(customerId) => change({ customerId })}
          onCreate={(name) => setCustomerParams({ createCustomer: true, name })}
          onEdit={(customerId) => setCustomerParams({ customerId })}
          disabled={locked}
        />
      </Field>

      <Field label="Title" className="col-span-2">
        <Input
          aria-label="Title"
          value={title}
          maxLength={300}
          disabled={locked}
          onChange={(event) => {
            setTitle(event.target.value);
            // An empty title is refused; the last one stands until typed over.
            if (event.target.value.trim())
              change({ title: event.target.value });
          }}
          onBlur={() => setTitle(draft.title)}
        />
      </Field>

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

      <div className="grid grid-cols-2 gap-x-6">
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
      </div>
    </div>
  );
}
