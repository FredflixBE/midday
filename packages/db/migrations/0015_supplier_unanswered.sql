-- FF-1600: remember that the model was asked about a payment and could not
-- name its supplier, so the next payment from that party is not asked again.
ALTER TABLE "transactions" ADD COLUMN "supplier_unanswered_at" timestamp with time zone;