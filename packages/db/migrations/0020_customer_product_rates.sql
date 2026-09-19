CREATE TABLE "customer_product_rates" (
	"customer_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"team_id" uuid NOT NULL,
	"hourly_rate" numeric(10, 2) NOT NULL,
	CONSTRAINT "customer_product_rates_pkey" PRIMARY KEY("customer_id","product_id")
);
--> statement-breakpoint
ALTER TABLE "customer_product_rates" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "customer_product_rates" ADD CONSTRAINT "customer_product_rates_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_product_rates" ADD CONSTRAINT "customer_product_rates_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "public"."invoice_products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_product_rates" ADD CONSTRAINT "customer_product_rates_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "customer_product_rates_team_id_idx" ON "customer_product_rates" USING btree ("team_id");--> statement-breakpoint
CREATE INDEX "customer_product_rates_product_id_idx" ON "customer_product_rates" USING btree ("product_id");--> statement-breakpoint
CREATE POLICY "Customer product rates can be handled by members of the team" ON "customer_product_rates" AS PERMISSIVE FOR ALL TO public USING ((team_id IN ( SELECT private.get_teams_for_authenticated_user() AS get_teams_for_authenticated_user)));--> statement-breakpoint
-- FF-1620: quotes price from products, not work types. Each work type becomes
-- a product with the same id, so every quote line that names it still
-- prices; its rate is the product's price, per hour. A product already named
-- the same at the same price keeps its name, and this one says it is hourly.
INSERT INTO "invoice_products" ("id", "created_at", "team_id", "name", "price", "currency", "unit", "is_active")
SELECT
	w."id",
	w."created_at",
	w."team_id",
	CASE WHEN EXISTS (
		SELECT 1 FROM "invoice_products" p
		WHERE p."team_id" = w."team_id"
			AND p."name" = w."name"
			AND p."currency" IS NOT DISTINCT FROM w."currency"
			AND p."price" = w."hourly_rate"
	) THEN w."name" || ' (hourly)' ELSE w."name" END,
	w."hourly_rate",
	w."currency",
	'hour',
	w."archived_at" IS NULL
FROM "work_types" w
ON CONFLICT ("id") DO NOTHING;--> statement-breakpoint
INSERT INTO "customer_product_rates" ("customer_id", "product_id", "team_id", "hourly_rate")
SELECT "customer_id", "work_type_id", "team_id", "hourly_rate" FROM "customer_work_type_rates"
ON CONFLICT DO NOTHING;--> statement-breakpoint
-- The ids are unchanged; only the keys that name them are. jsonb prints a key
-- as "key": with one space, and a key typed inside text is escaped, so these
-- replacements only ever meet keys.
UPDATE "quote_versions"
SET "content" = replace(
	replace("content"::text, '"workTypeId": ', '"productId": '),
	'"workTypeRates": ', '"productRates": '
)::jsonb;--> statement-breakpoint
UPDATE "quote_versions"
SET "pricing" = replace(
	replace("pricing"::text, '"workTypeId": ', '"productId": '),
	'"workTypes": ', '"products": '
)::jsonb
WHERE "pricing" IS NOT NULL;
