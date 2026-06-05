CREATE TABLE IF NOT EXISTS "analytical_features" (
	"ticker" text NOT NULL,
	"window_start" bigint NOT NULL,
	"ret" double precision,
	"rvol" double precision,
	"rvol_conf" text,
	"pcr" double precision,
	"iv_rank" double precision,
	"breadth" integer,
	"h_m" double precision,
	CONSTRAINT "analytical_features_ticker_window_start_pk" PRIMARY KEY("ticker","window_start")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "baselines" (
	"ticker" text NOT NULL,
	"how" integer NOT NULL,
	"mention_mean" double precision,
	"mention_std" double precision,
	"vol_mean" double precision,
	CONSTRAINT "baselines_ticker_how_pk" PRIMARY KEY("ticker","how")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "empirical_features" (
	"ticker" text NOT NULL,
	"window_start" bigint NOT NULL,
	"mentions" integer,
	"authors" integer,
	"sov" double precision,
	"velocity" double precision,
	"accel" double precision,
	"z" double precision,
	"net_dir" double precision,
	"dd_count" integer,
	"flair_counts" jsonb,
	"baseline_status" text,
	"h_e" double precision,
	CONSTRAINT "empirical_features_ticker_window_start_pk" PRIMARY KEY("ticker","window_start")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "market_bars" (
	"ticker" text NOT NULL,
	"ts" bigint NOT NULL,
	"o" double precision,
	"h" double precision,
	"l" double precision,
	"c" double precision,
	"volume" bigint,
	"vwap" double precision,
	"feed" text,
	"as_of" bigint,
	CONSTRAINT "market_bars_ticker_ts_pk" PRIMARY KEY("ticker","ts")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "market_movers" (
	"ts" bigint NOT NULL,
	"kind" text NOT NULL,
	"rank" integer NOT NULL,
	"symbol" text,
	"price" double precision,
	"percent_change" double precision,
	"volume" bigint,
	CONSTRAINT "market_movers_ts_kind_rank_pk" PRIMARY KEY("ts","kind","rank")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "mentions" (
	"ticker" text NOT NULL,
	"thing_id" text NOT NULL,
	"thing_type" text,
	"created_utc" bigint,
	"author" text,
	"flair" text,
	"direction" text,
	CONSTRAINT "mentions_ticker_thing_id_pk" PRIMARY KEY("ticker","thing_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "options_snapshot" (
	"ticker" text NOT NULL,
	"ts" bigint NOT NULL,
	"call_vol" bigint,
	"put_vol" bigint,
	"pcr" double precision,
	"call_oi" bigint,
	"put_oi" bigint,
	"atm_iv" double precision,
	"iv_rank" double precision,
	"breadth_strikes" integer,
	"breadth_expiries" integer,
	"feed" text,
	"as_of" bigint,
	CONSTRAINT "options_snapshot_ticker_ts_pk" PRIMARY KEY("ticker","ts")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "raw_comments" (
	"id" text PRIMARY KEY NOT NULL,
	"created_utc" bigint,
	"author" text,
	"link_id" text,
	"parent_id" text,
	"body" text,
	"score" integer,
	"retrieved_on" bigint,
	"source" text
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "raw_posts" (
	"id" text PRIMARY KEY NOT NULL,
	"created_utc" bigint,
	"author" text,
	"title" text,
	"selftext" text,
	"link_flair_text" text,
	"score" integer,
	"num_comments" integer,
	"retrieved_on" bigint,
	"source" text
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "signals" (
	"ticker" text NOT NULL,
	"window_start" bigint NOT NULL,
	"h_e" double precision,
	"h_m" double precision,
	"divergence" double precision,
	"quadrant" text,
	"rank" integer,
	"rank_delta" integer,
	"lead_lag_hrs" double precision,
	CONSTRAINT "signals_ticker_window_start_pk" PRIMARY KEY("ticker","window_start")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "ticker_names" (
	"symbol" text PRIMARY KEY NOT NULL,
	"name" text
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "analytical_features_window_start_idx" ON "analytical_features" USING btree ("window_start");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "empirical_features_window_start_idx" ON "empirical_features" USING btree ("window_start");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "mentions_created_utc_idx" ON "mentions" USING btree ("created_utc");