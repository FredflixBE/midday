-- FF-1674: the general terms are written in Midday and printed with the quote,
-- rather than uploaded as a PDF and referenced by name.
--
-- `content` holds the same Tiptap document a quote's text blocks hold. The
-- file columns become nullable and stay for the versions uploaded under
-- FF-1616: a PDF cannot be turned into rich text, so nothing is migrated and
-- those rows keep behaving exactly as they did. A sent quote that names one
-- must go on resolving.
ALTER TABLE "quote_terms" ALTER COLUMN "file_path" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "quote_terms" ALTER COLUMN "file_name" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "quote_terms" ADD COLUMN "content" jsonb;