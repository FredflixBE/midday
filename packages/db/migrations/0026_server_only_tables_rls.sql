-- FF-1688: row level security on the six tables only the server reads.
--
-- They had none, and Supabase grants anon and authenticated everything on
-- `public`, so anyone holding the publishable key could read and write them
-- through the Data API. No policies: the API connects as the owner and is not
-- subject to RLS, and nothing else should reach these tables.
--
-- Both projects were fixed by hand on 2026-09-23, so this changes nothing on
-- either; ENABLE on a table that already has it is a no-op. It is here so a
-- database built from these files matches them.
ALTER TABLE "api_keys" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "institutions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "invoice_comments" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "oauth_access_tokens" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "oauth_authorization_codes" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "transaction_match_suggestions" ENABLE ROW LEVEL SECURITY;
