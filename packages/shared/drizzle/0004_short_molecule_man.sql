CREATE TABLE "play_extractions" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "play_extractions_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"play_id" text NOT NULL,
	"run_at" bigint NOT NULL,
	"model" text,
	"prompt_version" text,
	"output" jsonb,
	"tokens_in" integer,
	"tokens_out" integer,
	"cost_usd" double precision
);
--> statement-breakpoint
CREATE TABLE "play_interpretations" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "play_interpretations_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"play_id" text NOT NULL,
	"run_at" bigint NOT NULL,
	"model" text,
	"prompt_version" text,
	"evidence" jsonb,
	"output" jsonb,
	"tokens_in" integer,
	"tokens_out" integer,
	"cost_usd" double precision
);
--> statement-breakpoint
CREATE TABLE "play_links" (
	"play_id" text NOT NULL,
	"resolution_play_id" text NOT NULL,
	"kind" text,
	"linked_at" bigint,
	CONSTRAINT "play_links_play_id_resolution_play_id_pk" PRIMARY KEY("play_id","resolution_play_id")
);
--> statement-breakpoint
CREATE TABLE "play_marks" (
	"play_id" text NOT NULL,
	"position_id" text NOT NULL,
	"ts" bigint NOT NULL,
	"mark_value" double precision,
	"pnl_abs" double precision,
	"pnl_pct" double precision,
	"source" text,
	"feed_conf" text,
	"note" text,
	CONSTRAINT "play_marks_play_id_position_id_ts_pk" PRIMARY KEY("play_id","position_id","ts")
);
--> statement-breakpoint
CREATE TABLE "plays" (
	"id" text PRIMARY KEY NOT NULL,
	"created_utc" bigint,
	"captured_at" bigint,
	"published_at" bigint,
	"author" text,
	"flair" text,
	"title" text,
	"selftext" text,
	"permalink" text,
	"url" text,
	"is_gallery" boolean,
	"media" jsonb,
	"media_status" text,
	"raw" jsonb,
	"score" integer,
	"num_comments" integer,
	"removed" boolean,
	"refreshed_at" bigint,
	"status" text NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" bigint,
	"claimed_at" bigint,
	"error" text,
	"media_retry_until" bigint,
	"current_extraction_at" bigint,
	"current_interpretation_at" bigint,
	"primary_ticker" text,
	"category" text,
	"tags" jsonb,
	"confidence" double precision,
	"pnl_abs" double precision,
	"pnl_pct" double precision,
	"realized" boolean,
	"summary" text,
	"tldr" text,
	"extractor_version" text,
	"interpreter_version" text,
	"taxonomy_version" text,
	"track_status" text,
	"track_until" bigint
);
--> statement-breakpoint
CREATE UNIQUE INDEX "play_extractions_play_run_idx" ON "play_extractions" USING btree ("play_id","run_at");--> statement-breakpoint
CREATE UNIQUE INDEX "play_interpretations_play_run_idx" ON "play_interpretations" USING btree ("play_id","run_at");--> statement-breakpoint
CREATE INDEX "plays_status_idx" ON "plays" USING btree ("status");--> statement-breakpoint
CREATE INDEX "plays_published_at_idx" ON "plays" USING btree ("published_at");--> statement-breakpoint
CREATE INDEX "plays_primary_ticker_idx" ON "plays" USING btree ("primary_ticker");--> statement-breakpoint
CREATE INDEX "plays_category_idx" ON "plays" USING btree ("category");--> statement-breakpoint
CREATE INDEX "plays_track_idx" ON "plays" USING btree ("track_status","track_until");--> statement-breakpoint
CREATE INDEX "plays_author_ticker_idx" ON "plays" USING btree ("author","primary_ticker");