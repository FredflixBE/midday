CREATE TYPE "public"."supplier_link" AS ENUM('rule', 'ai', 'person');--> statement-breakpoint
CREATE TYPE "public"."supplier_rule_field" AS ENUM('counterparty_iban', 'counterparty_name', 'name');--> statement-breakpoint
CREATE TABLE "supplier_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"team_id" uuid NOT NULL,
	"supplier_id" uuid,
	"field" "supplier_rule_field" NOT NULL,
	"value" text NOT NULL,
	"source" text DEFAULT 'manual' NOT NULL,
	CONSTRAINT "supplier_rules_team_id_field_value_key" UNIQUE("team_id","field","value")
);
--> statement-breakpoint
ALTER TABLE "supplier_rules" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "suppliers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"team_id" uuid NOT NULL,
	"name" text NOT NULL,
	"vat_number" text,
	"default_category_id" uuid,
	"can_have_supplier_invoice" boolean,
	"source" text DEFAULT 'manual' NOT NULL,
	"external_id" text,
	"aliases" text[] DEFAULT '{}'::text[] NOT NULL
);
--> statement-breakpoint
ALTER TABLE "suppliers" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "transactions" ADD COLUMN "supplier_id" uuid;--> statement-breakpoint
ALTER TABLE "transactions" ADD COLUMN "supplier_rule_id" uuid;--> statement-breakpoint
ALTER TABLE "transactions" ADD COLUMN "supplier_link" "supplier_link";--> statement-breakpoint
ALTER TABLE "supplier_rules" ADD CONSTRAINT "supplier_rules_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_rules" ADD CONSTRAINT "supplier_rules_supplier_id_fkey" FOREIGN KEY ("supplier_id") REFERENCES "public"."suppliers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "suppliers" ADD CONSTRAINT "suppliers_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "suppliers" ADD CONSTRAINT "suppliers_default_category_id_fkey" FOREIGN KEY ("default_category_id") REFERENCES "public"."transaction_categories"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "supplier_rules_supplier_id_idx" ON "supplier_rules" USING btree ("supplier_id");--> statement-breakpoint
CREATE INDEX "suppliers_team_id_idx" ON "suppliers" USING btree ("team_id");--> statement-breakpoint
CREATE UNIQUE INDEX "suppliers_team_id_name_key" ON "suppliers" USING btree ("team_id",lower("name"));--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_supplier_id_fkey" FOREIGN KEY ("supplier_id") REFERENCES "public"."suppliers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_supplier_rule_id_fkey" FOREIGN KEY ("supplier_rule_id") REFERENCES "public"."supplier_rules"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "transactions_supplier_id_idx" ON "transactions" USING btree ("supplier_id");--> statement-breakpoint
CREATE POLICY "Supplier rules can be handled by members of the team" ON "supplier_rules" AS PERMISSIVE FOR ALL TO public USING ((team_id IN ( SELECT private.get_teams_for_authenticated_user() AS get_teams_for_authenticated_user)));--> statement-breakpoint
CREATE POLICY "Suppliers can be handled by members of the team" ON "suppliers" AS PERMISSIVE FOR ALL TO public USING ((team_id IN ( SELECT private.get_teams_for_authenticated_user() AS get_teams_for_authenticated_user)));