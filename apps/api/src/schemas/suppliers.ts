import { z } from "@hono/zod-openapi";

const supplierFields = {
  name: z.string().trim().min(1).max(200),
  vatNumber: z.string().trim().max(50).nullable().optional(),
  canHaveSupplierInvoice: z.boolean().nullable().optional(),
};

export const getSupplierByIdSchema = z.object({ id: z.string().uuid() });

export const createSupplierSchema = z.object(supplierFields);

export const updateSupplierSchema = z.object({
  id: z.string().uuid(),
  ...supplierFields,
  name: supplierFields.name.optional(),
});

export const deleteSupplierSchema = z.object({ id: z.string().uuid() });

export const mergeSuppliersSchema = z.object({
  /** The supplier that goes away. */
  sourceId: z.string().uuid(),
  /** The supplier that is kept. */
  targetId: z.string().uuid(),
});

export const supplierRuleFieldSchema = z.enum([
  "counterparty_iban",
  "counterparty_name",
  "name",
]);

export const supplierRuleSchema = z.object({
  /** Null for a rule saying this text names nobody. */
  supplierId: z.string().uuid().nullable(),
  field: supplierRuleFieldSchema,
  value: z.string().trim().min(1).max(500),
});

export const deleteSupplierRuleSchema = z.object({ id: z.string().uuid() });

export const setTransactionSupplierSchema = z.object({
  transactionId: z.string().uuid(),
  /** Null says this payment has no supplier. */
  supplierId: z.string().uuid().nullable(),
});

export const resetTransactionSupplierSchema = z.object({
  transactionId: z.string().uuid(),
});
