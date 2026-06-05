CREATE TABLE "cycle_runs" (
	"window_start" bigint PRIMARY KEY NOT NULL,
	"generated_at" bigint,
	"total_mentions" integer,
	"quiet" boolean,
	"capped" boolean,
	"status" text
);
