-- FF-1555, decided with Frederik on 2026-09-18: a category belongs to the
-- payment, not the supplier. The supplier's category is read from its
-- payments (the one they share, or "mixed"), and fixing it means
-- recategorising the payments, in bulk from the supplier's page.
ALTER TABLE "suppliers" DROP CONSTRAINT "suppliers_default_category_id_fkey";
--> statement-breakpoint
ALTER TABLE "suppliers" DROP COLUMN "default_category_id";