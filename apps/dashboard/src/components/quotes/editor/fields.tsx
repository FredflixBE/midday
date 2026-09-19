"use client";

import { Calendar } from "@midday/ui/calendar";
import { cn } from "@midday/ui/cn";
import { Input } from "@midday/ui/input";
import { Label } from "@midday/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "@midday/ui/popover";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@midday/ui/select";
import { formatDate } from "@midday/utils/format";
import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useState,
} from "react";
import { useUserQuery } from "@/hooks/use-user";

/**
 * True on a version that has been sent. A disabled fieldset already stops
 * inputs and buttons; a Radix select opens on pointerdown, which a disabled
 * button can still receive, so selects read this as well.
 */
export const ReadOnlyContext = createContext(false);

export const KIND_LABELS = { project: "Project", recurring: "Recurring" };
export const MODE_LABELS = { estimate: "Estimate", firm: "Firm offer" };
export const LANGUAGE_LABELS = { nl: "Dutch", en: "English" };

/** A choice between a few fixed values, each with its label. */
export function OptionSelect<T extends string>({
  value,
  options,
  onChange,
  disabled,
  placeholder,
  "aria-label": ariaLabel,
}: {
  value: T | undefined;
  options: Record<T, string>;
  onChange: (value: T) => void;
  disabled?: boolean;
  placeholder?: string;
  "aria-label"?: string;
}) {
  const readOnly = useContext(ReadOnlyContext);

  return (
    <Select
      value={value}
      onValueChange={(next) => onChange(next as T)}
      disabled={disabled || readOnly}
    >
      <SelectTrigger aria-label={ariaLabel}>
        <SelectValue placeholder={placeholder} />
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

export function Field({
  label,
  className,
  children,
}: {
  label: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div className={cn("flex min-w-0 flex-col gap-2", className)}>
      <Label className="text-[12px] font-normal text-[#606060]">{label}</Label>
      {children}
    </div>
  );
}

function parse(text: string) {
  const value = Number(text.replace(",", "."));
  return text.trim() === "" || !Number.isFinite(value) ? null : value;
}

/**
 * A number typed as text, so a half-typed "1," or an emptied field is not
 * turned into 0 under the cursor. It reports a number, or null when empty.
 */
export function NumberInput({
  value,
  onChange,
  min = 0,
  max,
  integer = false,
  commitOnBlur = false,
  className,
  ...props
}: {
  value: number | null;
  onChange: (value: number | null) => void;
  min?: number;
  max?: number;
  integer?: boolean;
  /** Report only when the field is left, for a value checked against another. */
  commitOnBlur?: boolean;
  className?: string;
  placeholder?: string;
  "aria-label"?: string;
}) {
  const [text, setText] = useState(value === null ? "" : String(value));

  // Follow a change made elsewhere, not the one being typed; an emptied
  // field that reported 0 stays empty until it is left.
  useEffect(() => {
    const shown = parse(text);
    if (shown !== value && !(shown === null && value === 0)) {
      setText(value === null ? "" : String(value));
    }
  }, [value]);

  const accept = (next: number | null) =>
    next === null ||
    ((!integer || Number.isInteger(next)) &&
      next >= min &&
      (max === undefined || next <= max));

  return (
    <Input
      {...props}
      inputMode={integer ? "numeric" : "decimal"}
      value={text}
      onChange={(event) => {
        setText(event.target.value);
        const next = parse(event.target.value);
        if (!commitOnBlur && accept(next)) onChange(next);
      }}
      onBlur={() => {
        const next = parse(text);
        if (commitOnBlur && next !== value && accept(next)) onChange(next);
        else setText(value === null ? "" : String(value));
      }}
      className={cn("text-right tabular-nums", className)}
    />
  );
}

/** A `YYYY-MM-DD` date, picked from a calendar. */
export function DateField({
  value,
  onChange,
  disabledBefore,
  "aria-label": ariaLabel,
}: {
  value: string;
  onChange: (value: string) => void;
  disabledBefore?: string;
  "aria-label"?: string;
}) {
  const { data: user } = useUserQuery();
  const [open, setOpen] = useState(false);
  const selected = new Date(`${value}T00:00:00`);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        aria-label={ariaLabel}
        className="flex h-9 w-full items-center border border-border bg-transparent px-3 text-left text-sm disabled:cursor-not-allowed disabled:opacity-50"
      >
        {formatDate(value, user?.dateFormat)}
      </PopoverTrigger>
      <PopoverContent className="w-auto p-0" align="start">
        <Calendar
          mode="single"
          weekStartsOn={user?.weekStartsOnMonday ? 1 : 0}
          defaultMonth={selected}
          selected={selected}
          disabled={
            disabledBefore
              ? { before: new Date(`${disabledBefore}T00:00:00`) }
              : undefined
          }
          onSelect={(date) => {
            if (!date) return;
            const pad = (n: number) => String(n).padStart(2, "0");
            onChange(
              `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`,
            );
            setOpen(false);
          }}
          initialFocus
        />
      </PopoverContent>
    </Popover>
  );
}
