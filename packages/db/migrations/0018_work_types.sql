-- FF-1607: work types and their rates. A fixed team-wide list, each with a
-- default hourly rate, which a customer can override per type.
CREATE TABLE "customer_work_type_rates" (
	"customer_id" uuid NOT NULL,
	"work_type_id" uuid NOT NULL,
	"team_id" uuid NOT NULL,
	"hourly_rate" numeric(10, 2) NOT NULL,
	CONSTRAINT "customer_work_type_rates_pkey" PRIMARY KEY("customer_id","work_type_id")
);
--> statement-breakpoint
ALTER TABLE "customer_work_type_rates" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "work_types" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"team_id" uuid NOT NULL,
	"name" text NOT NULL,
	"hourly_rate" numeric(10, 2) NOT NULL,
	"currency" text NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"archived_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "work_types" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "customer_work_type_rates" ADD CONSTRAINT "customer_work_type_rates_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_work_type_rates" ADD CONSTRAINT "customer_work_type_rates_work_type_id_fkey" FOREIGN KEY ("work_type_id") REFERENCES "public"."work_types"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_work_type_rates" ADD CONSTRAINT "customer_work_type_rates_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_types" ADD CONSTRAINT "work_types_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "customer_work_type_rates_team_id_idx" ON "customer_work_type_rates" USING btree ("team_id");--> statement-breakpoint
CREATE INDEX "customer_work_type_rates_work_type_id_idx" ON "customer_work_type_rates" USING btree ("work_type_id");--> statement-breakpoint
CREATE INDEX "work_types_team_id_idx" ON "work_types" USING btree ("team_id");--> statement-breakpoint
CREATE POLICY "Customer work type rates can be handled by members of the team" ON "customer_work_type_rates" AS PERMISSIVE FOR ALL TO public USING ((team_id IN ( SELECT private.get_teams_for_authenticated_user() AS get_teams_for_authenticated_user)));--> statement-breakpoint
CREATE POLICY "Work types can be handled by members of the team" ON "work_types" AS PERMISSIVE FOR ALL TO public USING ((team_id IN ( SELECT private.get_teams_for_authenticated_user() AS get_teams_for_authenticated_user)));