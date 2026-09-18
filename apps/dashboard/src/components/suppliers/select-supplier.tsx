"use client";

import { ComboboxDropdown } from "@midday/ui/combobox-dropdown";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTRPC } from "@/trpc/client";

/** The item that says "this payment has no supplier", which is an answer too. */
export const NO_SUPPLIER = "__no_supplier__";

type Item = { id: string; label: string };

type Props = {
  selected?: { id: string; name: string } | null;
  /** Null for "no supplier". */
  onChange: (supplier: { id: string; name: string } | null) => void;
  /** Offer "No supplier" as a choice. */
  allowNone?: boolean;
  /** Offer to create a supplier from what was typed. */
  allowCreate?: boolean;
  /** Leave these out, e.g. the supplier being merged away. */
  exclude?: string[];
  placeholder?: string;
  disabled?: boolean;
};

export function SelectSupplier({
  selected,
  onChange,
  allowNone,
  allowCreate = true,
  exclude = [],
  placeholder = "Select supplier",
  disabled,
}: Props) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const { data } = useQuery(trpc.suppliers.list.queryOptions());

  const create = useMutation(
    trpc.suppliers.create.mutationOptions({
      onSuccess: (supplier) => {
        queryClient.invalidateQueries({
          queryKey: trpc.suppliers.list.queryKey(),
        });
        onChange({ id: supplier.id, name: supplier.name });
      },
    }),
  );

  const items: Item[] = [
    ...(allowNone ? [{ id: NO_SUPPLIER, label: "No supplier" }] : []),
    ...(data ?? [])
      .filter((supplier) => !exclude.includes(supplier.id))
      .map((supplier) => ({ id: supplier.id, label: supplier.name })),
  ];

  return (
    <ComboboxDropdown
      disabled={disabled || create.isPending}
      placeholder={placeholder}
      searchPlaceholder="Search supplier"
      items={items}
      selectedItem={
        selected ? { id: selected.id, label: selected.name } : undefined
      }
      onSelect={(item) => {
        onChange(
          item.id === NO_SUPPLIER ? null : { id: item.id, name: item.label },
        );
      }}
      {...(allowCreate && {
        onCreate: (name: string) => create.mutate({ name }),
        renderOnCreate: (name: string) => <span>{`Create "${name}"`}</span>,
      })}
      renderListItem={({ item }) => (
        <span
          className={
            item.id === NO_SUPPLIER ? "text-[#878787]" : "line-clamp-1"
          }
        >
          {item.label}
        </span>
      )}
    />
  );
}
