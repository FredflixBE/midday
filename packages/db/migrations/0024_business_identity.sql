-- FF-1641: the business's own identity, as fields rather than the free text
-- of an invoice template's From box. WVV art. 2:20 asks a company to state
-- its name, legal form, registered office, enterprise number and the court of
-- the RPR on what it sends out; WER art. III.25 asks for a bank account. None
-- of it had a home: it lived only in `invoice_templates.from_details`, typed
-- into one screen and invisible to quotes.
--
-- Every column is nullable and nothing is backfilled. A team that has only
-- the old From blob keeps using it — the identity is the default, the
-- template's blob stays an override.
ALTER TABLE "teams" ADD COLUMN "legal_name" text;--> statement-breakpoint
ALTER TABLE "teams" ADD COLUMN "legal_form" text;--> statement-breakpoint
ALTER TABLE "teams" ADD COLUMN "address_line_1" text;--> statement-breakpoint
ALTER TABLE "teams" ADD COLUMN "address_line_2" text;--> statement-breakpoint
ALTER TABLE "teams" ADD COLUMN "city" text;--> statement-breakpoint
ALTER TABLE "teams" ADD COLUMN "zip" text;--> statement-breakpoint
ALTER TABLE "teams" ADD COLUMN "enterprise_number" text;--> statement-breakpoint
ALTER TABLE "teams" ADD COLUMN "rpr_court" text;--> statement-breakpoint
ALTER TABLE "teams" ADD COLUMN "bank_iban" text;--> statement-breakpoint
ALTER TABLE "teams" ADD COLUMN "bank_bic" text;