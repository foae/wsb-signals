ALTER TABLE "cycle_runs" ADD COLUMN "repaired_at" bigint;--> statement-breakpoint
CREATE INDEX "mentions_thing_type_id_idx" ON "mentions" USING btree ("thing_type","thing_id");--> statement-breakpoint
CREATE INDEX "raw_comments_removed_idx" ON "raw_comments" USING btree ("removed");--> statement-breakpoint
CREATE INDEX "raw_posts_removed_idx" ON "raw_posts" USING btree ("removed");