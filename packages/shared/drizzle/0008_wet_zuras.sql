ALTER TABLE "raw_comments" ADD COLUMN "removed" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "raw_posts" ADD COLUMN "removed" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
UPDATE "raw_posts"
SET "removed" = true
WHERE lower(trim(coalesce("title", ''))) IN ('[removed]', '[deleted]')
   OR lower(trim(coalesce("selftext", ''))) IN ('[removed]', '[deleted]');--> statement-breakpoint
UPDATE "raw_comments"
SET "removed" = true
WHERE lower(trim(coalesce("body", ''))) IN ('[removed]', '[deleted]');