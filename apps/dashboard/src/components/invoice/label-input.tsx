"use client";

import { cn } from "@midday/ui/cn";
import { useFormContext, useWatch } from "react-hook-form";

type Props = {
  name: string;
  required?: boolean;
  className?: string;
  onSave?: (value: string) => void;
  defaultValue?: string;
};

export function LabelInput({ name, className, onSave, defaultValue }: Props) {
  const { setValue, control } = useFormContext();
  const value = useWatch({ control, name });
  const displayValue = value ?? defaultValue ?? "";

  return (
    <span
      className={cn(
        "text-[11px] text-muted-foreground min-w-10 outline-hidden",
        className,
      )}
      id={name}
      contentEditable
      suppressContentEditableWarning
      onBlur={(e) => {
        const newValue = e.currentTarget.textContent || "";

        // Only call onSave if the value has changed from what was displayed
        if (newValue !== displayValue) {
          setValue(name, newValue, { shouldValidate: true, shouldDirty: true });
          onSave?.(newValue);
        }
      }}
    >
      {displayValue}
    </span>
  );
}
