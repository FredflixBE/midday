-- FF-1616: the team general terms versions, and the one a sent quote went
-- out with. Terms only bind if the client could know them beforehand, so the
-- reference is restricted: terms a sent version names cannot be deleted.
CREATE TABLE "quote_terms" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"team_id" uuid NOT NULL,
	"label" text NOT NULL,
	"language" text NOT NULL,
	"file_path" text[] NOT NULL,
	"file_name" text NOT NULL,
	CONSTRAINT "quote_terms_team_id_label_language_key" UNIQUE("team_id","label","language")
);
--> statement-breakpoint
ALTER TABLE "quote_terms" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "quote_versions" ADD COLUMN "terms_version_id" uuid;--> statement-breakpoint
ALTER TABLE "quote_terms" ADD CONSTRAINT "quote_terms_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "quote_terms_team_id_idx" ON "quote_terms" USING btree ("team_id");--> statement-breakpoint
ALTER TABLE "quote_versions" ADD CONSTRAINT "quote_versions_terms_version_id_fkey" FOREIGN KEY ("terms_version_id") REFERENCES "public"."quote_terms"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE POLICY "Quote terms can be handled by members of the team" ON "quote_terms" AS PERMISSIVE FOR ALL TO public USING ((team_id IN ( SELECT private.get_teams_for_authenticated_user() AS get_teams_for_authenticated_user)));