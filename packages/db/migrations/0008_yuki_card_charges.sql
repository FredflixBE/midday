CREATE TYPE "public"."books_status" AS ENUM('invoice_missing', 'in_the_books', 'needs_attention');--> statement-breakpoint
ALTER TYPE "public"."bank_providers" ADD VALUE 'yuki';--> statement-breakpoint
ALTER TABLE "transactions" ADD COLUMN "books_status" "books_status";--> statement-breakpoint
ALTER TABLE "transactions" ADD COLUMN "books_status_reason" text;