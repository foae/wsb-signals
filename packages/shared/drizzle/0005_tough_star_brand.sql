CREATE TABLE "ingestion_runs" (
	"source" text NOT NULL,
	"kind" text NOT NULL,
	"poll_ts" bigint NOT NULL,
	"status" text NOT NULL,
	"oldest_utc" bigint,
	"newest_utc" bigint,
	"items_fetched" integer NOT NULL,
	"pages" integer NOT NULL,
	"capped" boolean NOT NULL,
	"lag_seconds" integer,
	CONSTRAINT "ingestion_runs_source_kind_poll_ts_pk" PRIMARY KEY("source","kind","poll_ts")
);
--> statement-breakpoint
ALTER TABLE "analytical_features" ADD COLUMN "feed" text;--> statement-breakpoint
ALTER TABLE "analytical_features" ADD COLUMN "as_of" bigint;--> statement-breakpoint
ALTER TABLE "cycle_runs" ADD COLUMN "finalized_at" bigint;--> statement-breakpoint
ALTER TABLE "cycle_runs" ADD COLUMN "newest_post_utc" bigint;--> statement-breakpoint
ALTER TABLE "cycle_runs" ADD COLUMN "newest_comment_utc" bigint;--> statement-breakpoint
ALTER TABLE "cycle_runs" ADD COLUMN "market_status" text;--> statement-breakpoint
ALTER TABLE "cycle_runs" ADD COLUMN "market_requested" integer;--> statement-breakpoint
ALTER TABLE "cycle_runs" ADD COLUMN "market_usable" integer;--> statement-breakpoint
ALTER TABLE "cycle_runs" ADD COLUMN "market_as_of" bigint;--> statement-breakpoint
CREATE INDEX "ingestion_runs_kind_poll_idx" ON "ingestion_runs" USING btree ("kind","poll_ts");