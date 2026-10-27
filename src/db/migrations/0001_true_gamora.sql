CREATE TYPE "public"."outbox_status" AS ENUM('pending', 'sent');--> statement-breakpoint
CREATE TABLE "outbox" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"payload" jsonb NOT NULL,
	"dedupe_key" text,
	"status" "outbox_status" DEFAULT 'pending' NOT NULL,
	"enqueued_at" timestamp with time zone,
	"attempts" integer DEFAULT 0 NOT NULL,
	"sent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "outbox_dedupe_key_unique" UNIQUE("dedupe_key")
);
--> statement-breakpoint
CREATE INDEX "outbox_pending_idx" ON "outbox" USING btree ("created_at") WHERE "outbox"."status" = 'pending';