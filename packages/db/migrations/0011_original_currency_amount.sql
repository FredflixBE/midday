ALTER TABLE "transactions" ADD COLUMN "original_amount" numeric(10, 2);--> statement-breakpoint
ALTER TABLE "transactions" ADD COLUMN "original_currency" text;--> statement-breakpoint
ALTER TABLE "transactions" ADD COLUMN "exchange_rate" numeric(18, 8);