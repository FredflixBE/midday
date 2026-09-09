ALTER TABLE "transaction_enrichments" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY "Enable insert for authenticated users only" ON "transaction_enrichments" CASCADE;--> statement-breakpoint
DROP POLICY "Enable update for authenticated users only" ON "transaction_enrichments" CASCADE;