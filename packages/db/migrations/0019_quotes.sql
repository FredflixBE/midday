-- FF-1609: quotes and their versions, and a team's quote settings. Scenarios
-- and lines live as jsonb in the version; expired is computed, never stored.
CREATE TYPE "public"."quote_kind" AS ENUM('project', 'recurring');--> statement-breakpoint
CREATE TYPE "public"."quote_mode" AS ENUM('estimate', 'firm');--> statement-breakpoint
CREATE TYPE "public"."quote_outcome" AS ENUM('open', 'won', 'lost', 'no_decision');--> statement-breakpoint
CREATE TYPE "public"."quote_version_status" AS ENUM('draft', 'sent', 'superseded', 'accepted');--> statement-breakpoint
CREATE TABLE "quote_settings" (
	"team_id" uuid PRIMARY KEY NOT NULL,
	"number_prefix" text DEFAULT 'OFF-' NOT NULL,
	"default_valid_days" integer DEFAULT 30 NOT NULL,
	"hours_per_day" numeric(4, 2) DEFAULT 8 NOT NULL,
	"default_blocks" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"labels" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
ALTER TABLE "quote_settings" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "quote_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"team_id" uuid NOT NULL,
	"quote_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"status" "quote_version_status" DEFAULT 'draft' NOT NULL,
	"mode" "quote_mode" DEFAULT 'estimate' NOT NULL,
	"issue_date" date NOT NULL,
	"valid_until" date NOT NULL,
	"sent_at" timestamp with time zone,
	"sent_to" text,
	"customer_details" jsonb,
	"from_details" jsonb,
	"content" jsonb NOT NULL,
	"pricing" jsonb,
	"internal_note" text,
	CONSTRAINT "quote_versions_quote_id_version_key" UNIQUE("quote_id","version")
);
--> statement-breakpoint
ALTER TABLE "quote_versions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "quotes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"team_id" uuid NOT NULL,
	"created_by" uuid,
	"customer_id" uuid,
	"quote_number" text NOT NULL,
	"title" text NOT NULL,
	"kind" "quote_kind" NOT NULL,
	"language" text NOT NULL,
	"currency" text NOT NULL,
	"outcome" "quote_outcome" DEFAULT 'open' NOT NULL,
	"outcome_reason" text,
	"outcome_at" timestamp with time zone,
	"tracker_project_id" uuid,
	CONSTRAINT "quotes_team_id_quote_number_key" UNIQUE("team_id","quote_number")
);
--> statement-breakpoint
ALTER TABLE "quotes" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "quote_settings" ADD CONSTRAINT "quote_settings_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quote_versions" ADD CONSTRAINT "quote_versions_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quote_versions" ADD CONSTRAINT "quote_versions_quote_id_fkey" FOREIGN KEY ("quote_id") REFERENCES "public"."quotes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quotes" ADD CONSTRAINT "quotes_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quotes" ADD CONSTRAINT "quotes_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quotes" ADD CONSTRAINT "quotes_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quotes" ADD CONSTRAINT "quotes_tracker_project_id_fkey" FOREIGN KEY ("tracker_project_id") REFERENCES "public"."tracker_projects"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "quote_versions_team_id_idx" ON "quote_versions" USING btree ("team_id");--> statement-breakpoint
CREATE UNIQUE INDEX "quote_versions_one_draft_idx" ON "quote_versions" USING btree ("quote_id") WHERE status = 'draft';--> statement-breakpoint
CREATE INDEX "quotes_team_id_idx" ON "quotes" USING btree ("team_id");--> statement-breakpoint
CREATE INDEX "quotes_customer_id_idx" ON "quotes" USING btree ("customer_id");--> statement-breakpoint
CREATE POLICY "Quote settings can be handled by members of the team" ON "quote_settings" AS PERMISSIVE FOR ALL TO public USING ((team_id IN ( SELECT private.get_teams_for_authenticated_user() AS get_teams_for_authenticated_user)));--> statement-breakpoint
CREATE POLICY "Quote versions can be handled by members of the team" ON "quote_versions" AS PERMISSIVE FOR ALL TO public USING ((team_id IN ( SELECT private.get_teams_for_authenticated_user() AS get_teams_for_authenticated_user)));--> statement-breakpoint
CREATE POLICY "Quotes can be handled by members of the team" ON "quotes" AS PERMISSIVE FOR ALL TO public USING ((team_id IN ( SELECT private.get_teams_for_authenticated_user() AS get_teams_for_authenticated_user)));