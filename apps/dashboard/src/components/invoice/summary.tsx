import { calculateTotal } from "@midday/invoice/calculate";
import { useEffect } from "react";
import { useFormContext, useWatch } from "react-hook-form";
import { useTemplateUpdate } from "@/hooks/use-template-update";
import { AnimatedNumber } from "../animated-number";
import { FormatAmount } from "../format-amount";
import { AmountInput } from "./amount-input";
import { LabelInput } from "./label-input";
import { TaxInput } from "./tax-input";
import { VATInput } from "./vat-input";

export function Summary() {
  const { control, getValues, setValue } = useFormContext();
  const { updateTemplate } = useTemplateUpdate();

  const includeDecimals = useWatch({
    control,
    name: "template.includeDecimals",
  });

  const maximumFractionDigits = includeDecimals ? 2 : 0;

  const currency = useWatch({
    control,
    name: "template.currency",
  });

  const locale = useWatch({
    control,
    name: "template.locale",
  });

  const includeTax = useWatch({
    control,
    name: "template.includeTax",
  });

  const taxRate = useWatch({
    control,
    name: "template.taxRate",
  });

  const vatRate = useWatch({
    control,
    name: "template.vatRate",
  });

  const includeVat = useWatch({
    control,
    name: "template.includeVat",
  });

  const includeDiscount = useWatch({
    control,
    name: "template.includeDiscount",
  });

  const includeLineItemTax = useWatch({
    control,
    name: "template.includeLineItemTax",
  });

  const lineItems = useWatch({
    control,
    name: "lineItems",
  });

  const discount = useWatch({
    control,
    name: "discount",
  });

  const {
    subTotal,
    total,
    vat: totalVAT,
    tax: totalTax,
  } = calculateTotal({
    lineItems,
    taxRate,
    vatRate,
    includeVat,
    includeTax,
    includeLineItemTax,
    discount: discount ?? 0,
  });

  // The form holds the totals because the draft autosave and submit read them
  // from it. Write only the ones that changed, and validate only a write that
  // turns a missing value into a number: every number calculateTotal returns
  // is valid, so validating each write ran the whole schema five times per
  // keystroke (FF-1716).
  useEffect(() => {
    const totals = {
      amount: total,
      vat: totalVAT,
      tax: totalTax,
      subtotal: subTotal,
      discount: discount ?? 0,
    };

    for (const [name, value] of Object.entries(totals)) {
      const current = getValues(name);

      if (current !== value) {
        setValue(name, value, { shouldValidate: typeof current !== "number" });
      }
    }
  }, [total, totalVAT, totalTax, subTotal, discount, getValues, setValue]);

  useEffect(() => {
    if (!includeTax) {
      setValue("template.taxRate", 0, {
        shouldValidate: true,
        shouldDirty: true,
      });
    }
  }, [includeTax]);

  useEffect(() => {
    if (!includeVat) {
      setValue("template.vatRate", 0, {
        shouldValidate: true,
        shouldDirty: true,
      });
    }
  }, [includeVat]);

  useEffect(() => {
    if (!includeDiscount) {
      setValue("discount", 0, { shouldValidate: true, shouldDirty: true });
    }
  }, [includeDiscount]);

  return (
    <div className="w-[320px] flex flex-col">
      <div className="flex justify-between items-center py-1">
        <LabelInput
          className="shrink-0 min-w-6"
          name="template.subtotalLabel"
          onSave={(value) => {
            updateTemplate({ subtotalLabel: value });
          }}
        />
        <span className="text-right text-[11px] text-muted-foreground">
          <FormatAmount
            amount={subTotal}
            maximumFractionDigits={maximumFractionDigits}
            currency={currency}
            locale={locale}
          />
        </span>
      </div>

      {includeDiscount && (
        <div className="flex justify-between items-center py-1">
          <LabelInput
            name="template.discountLabel"
            onSave={(value) => {
              updateTemplate({ discountLabel: value });
            }}
          />

          <AmountInput
            placeholder="0"
            allowNegative={false}
            name="discount"
            className="text-right text-[11px] text-muted-foreground border-none"
          />
        </div>
      )}

      {includeVat && (
        <div className="flex justify-between items-center py-1">
          <div className="flex items-center gap-1">
            <LabelInput
              className="shrink-0 min-w-5"
              name="template.vatLabel"
              onSave={(value) => {
                updateTemplate({ vatLabel: value });
              }}
            />

            <VATInput />
          </div>

          <span className="text-right text-[11px] text-muted-foreground">
            <FormatAmount
              amount={totalVAT}
              maximumFractionDigits={2}
              currency={currency}
              locale={locale}
            />
          </span>
        </div>
      )}

      {includeTax && !includeLineItemTax && (
        <div className="flex justify-between items-center py-1">
          <div className="flex items-center gap-1">
            <LabelInput
              className="shrink-0 min-w-5"
              name="template.taxLabel"
              onSave={(value) => {
                updateTemplate({ taxLabel: value });
              }}
            />

            <TaxInput />
          </div>

          <span className="text-right text-[11px] text-muted-foreground">
            <FormatAmount
              amount={totalTax}
              maximumFractionDigits={2}
              currency={currency}
              locale={locale}
            />
          </span>
        </div>
      )}

      {includeLineItemTax && totalTax > 0 && (
        <div className="flex justify-between items-center py-1">
          <LabelInput
            className="shrink-0 min-w-5"
            name="template.taxLabel"
            onSave={(value) => {
              updateTemplate({ taxLabel: value });
            }}
          />

          <span className="text-right text-[11px] text-muted-foreground">
            <FormatAmount
              amount={totalTax}
              maximumFractionDigits={2}
              currency={currency}
              locale={locale}
            />
          </span>
        </div>
      )}

      <div className="flex justify-between items-center py-4 mt-2 border-t border-border">
        <LabelInput
          name="template.totalSummaryLabel"
          onSave={(value) => {
            updateTemplate({ totalSummaryLabel: value });
          }}
        />
        <span className="text-right font-medium text-[21px]">
          <AnimatedNumber
            value={total}
            currency={currency}
            maximumFractionDigits={
              includeTax || includeVat || includeLineItemTax
                ? 2
                : maximumFractionDigits
            }
          />
        </span>
      </div>
    </div>
  );
}
