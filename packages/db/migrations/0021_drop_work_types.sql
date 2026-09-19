DROP POLICY "Customer work type rates can be handled by members of the team" ON "customer_work_type_rates" CASCADE;--> statement-breakpoint
DROP TABLE "customer_work_type_rates" CASCADE;--> statement-breakpoint
DROP POLICY "Work types can be handled by members of the team" ON "work_types" CASCADE;--> statement-breakpoint
DROP TABLE "work_types" CASCADE;