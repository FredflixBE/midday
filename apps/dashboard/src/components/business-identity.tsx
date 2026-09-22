"use client";

import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@midday/ui/card";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@midday/ui/form";
import { Input } from "@midday/ui/input";
import { SubmitButton } from "@midday/ui/submit-button";
import { z } from "zod/v3";
import { useTeamMutation, useTeamQuery } from "@/hooks/use-team";
import { useZodForm } from "@/hooks/use-zod-form";

/**
 * The business's own identity (FF-1641), in one place.
 *
 * Until this screen existed, every one of these fields lived only in the
 * From box of an invoice — free text, on a screen quotes could not reach.
 * A quote's Van block read "Frederik Noels" and nothing else, on a document
 * the law asks to carry the legal form, the registered office, the
 * enterprise number, the court of the RPR and a bank account.
 *
 * Nothing is required. A team fills this in over time, and the block leaves
 * out any line nothing was said for.
 */
const formSchema = z.object({
  legalName: z.string().max(200),
  legalForm: z.string().max(200),
  addressLine1: z.string().max(200),
  addressLine2: z.string().max(200),
  zip: z.string().max(200),
  city: z.string().max(200),
  enterpriseNumber: z.string().max(200),
  rprCourt: z.string().max(200),
  bankIban: z.string().max(200),
  bankBic: z.string().max(200),
});

type Fields = z.infer<typeof formSchema>;

const FIELDS: { name: keyof Fields; label: string; placeholder: string }[] = [
  { name: "legalName", label: "Registered name", placeholder: "Fredflix" },
  { name: "legalForm", label: "Legal form", placeholder: "BV" },
  {
    name: "addressLine1",
    label: "Registered office",
    placeholder: "Voorbeeldstraat 1",
  },
  { name: "addressLine2", label: "Address line 2", placeholder: "bus 3" },
  { name: "zip", label: "Postcode", placeholder: "2000" },
  { name: "city", label: "Town", placeholder: "Antwerpen" },
  {
    name: "enterpriseNumber",
    label: "Enterprise number",
    placeholder: "0123.456.789",
  },
  {
    name: "rprCourt",
    label: "RPR court",
    placeholder: "Antwerpen, afdeling Antwerpen",
  },
  { name: "bankIban", label: "IBAN", placeholder: "BE68 5390 0754 7034" },
  { name: "bankBic", label: "BIC", placeholder: "GKCCBEBB" },
];

export function BusinessIdentity() {
  const { data } = useTeamQuery();
  const updateTeamMutation = useTeamMutation();

  const form = useZodForm(formSchema, {
    defaultValues: Object.fromEntries(
      FIELDS.map(({ name }) => [name, data?.[name] ?? ""]),
    ) as Fields,
  });

  const onSubmit = form.handleSubmit((values) => {
    // Emptied means cleared, not left alone, so a field is sent as null
    // rather than dropped from what is saved.
    updateTeamMutation.mutate(
      Object.fromEntries(
        Object.entries(values).map(([key, value]) => [
          key,
          value.trim() || null,
        ]),
      ),
    );
  });

  return (
    <Form {...form}>
      <form onSubmit={onSubmit}>
        <Card>
          <CardHeader>
            <CardTitle>Business details</CardTitle>
            <CardDescription>
              What your quotes and invoices state about your business.
            </CardDescription>
          </CardHeader>

          <CardContent className="grid grid-cols-2 gap-4">
            {FIELDS.map(({ name, label, placeholder }) => (
              <FormField
                key={name}
                control={form.control}
                name={name}
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{label}</FormLabel>
                    <FormControl>
                      <Input {...field} placeholder={placeholder} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            ))}
          </CardContent>

          <CardFooter className="flex justify-end">
            <SubmitButton
              isSubmitting={updateTeamMutation.isPending}
              disabled={updateTeamMutation.isPending}
            >
              Save
            </SubmitButton>
          </CardFooter>
        </Card>
      </form>
    </Form>
  );
}
