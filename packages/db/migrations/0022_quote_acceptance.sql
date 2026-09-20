-- FF-1615: a quote version keeps the PDF that was sent, and what was
-- accepted: the scenario, the optional items taken, who answered and when,
-- the PO number, and the document that says so.
ALTER TABLE "quote_versions" ADD COLUMN "pdf_path" text[];--> statement-breakpoint
ALTER TABLE "quote_versions" ADD COLUMN "accepted_scenario_id" text;--> statement-breakpoint
ALTER TABLE "quote_versions" ADD COLUMN "accepted_optional_line_ids" text[];--> statement-breakpoint
ALTER TABLE "quote_versions" ADD COLUMN "accepted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "quote_versions" ADD COLUMN "accepted_by_name" text;--> statement-breakpoint
ALTER TABLE "quote_versions" ADD COLUMN "po_number" text;--> statement-breakpoint
ALTER TABLE "quote_versions" ADD COLUMN "acceptance_file_path" text[];