-- FF-1591: recurring commitments (ADR-48). A commitment is a payee, a rhythm
-- and an amount; detection proposes one, a person confirms, corrects or
-- rejects it, and later payments attach to it by themselves.
CREATE TYPE "public"."commitment_cadence" AS ENUM('monthly', 'quarterly', 'yearly');--> statement-breakpoint
CREATE TYPE "public"."commitment_kind" AS ENUM('subscription', 'direct_debit', 'leasing', 'tax');--> statement-breakpoint
CREATE TYPE "public"."commitment_link" AS ENUM('detected', 'person');--> statement-breakpoint
CREATE TYPE "public"."commitment_price_kind" AS ENUM('fixed', 'fixed_foreign', 'usage');--> statement-breakpoint
CREATE TYPE "public"."commitment_status" AS ENUM('proposed', 'active', 'rejected', 'ended');--> statement-breakpoint
CREATE TABLE "commitments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"team_id" uuid NOT NULL,
	"supplier_id" uuid NOT NULL,
	"kind" "commitment_kind" NOT NULL,
	"cadence" "commitment_cadence" NOT NULL,
	"day" smallint NOT NULL,
	"price_kind" "commitment_price_kind" NOT NULL,
	"amount" numeric(10, 2) NOT NULL,
	"currency" text NOT NULL,
	"amount_low" numeric(10, 2),
	"amount_high" numeric(10, 2),
	"billed_amount" numeric(10, 2),
	"billed_currency" text,
	"status" "commitment_status" DEFAULT 'proposed' NOT NULL,
	"ends_on" date
);
--> statement-breakpoint
ALTER TABLE "commitments" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "transactions" ADD COLUMN "commitment_id" uuid;--> statement-breakpoint
ALTER TABLE "transactions" ADD COLUMN "commitment_link" "commitment_link";--> statement-breakpoint
ALTER TABLE "commitments" ADD CONSTRAINT "commitments_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commitments" ADD CONSTRAINT "commitments_supplier_id_fkey" FOREIGN KEY ("supplier_id") REFERENCES "public"."suppliers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "commitments_team_id_idx" ON "commitments" USING btree ("team_id");--> statement-breakpoint
CREATE INDEX "commitments_supplier_id_idx" ON "commitments" USING btree ("supplier_id");--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_commitment_id_fkey" FOREIGN KEY ("commitment_id") REFERENCES "public"."commitments"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "transactions_commitment_id_idx" ON "transactions" USING btree ("commitment_id");--> statement-breakpoint
CREATE POLICY "Commitments can be handled by members of the team" ON "commitments" AS PERMISSIVE FOR ALL TO public USING ((team_id IN ( SELECT private.get_teams_for_authenticated_user() AS get_teams_for_authenticated_user)));