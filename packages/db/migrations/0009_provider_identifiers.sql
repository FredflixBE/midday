ALTER TABLE "transactions" ADD COLUMN "counterparty_iban" text;--> statement-breakpoint
ALTER TABLE "transactions" ADD COLUMN "bank_transaction_code" text;--> statement-breakpoint
ALTER TABLE "transactions" ADD COLUMN "bank_transaction_sub_code" text;--> statement-breakpoint
ALTER TABLE "transactions" ADD COLUMN "entry_reference" text;