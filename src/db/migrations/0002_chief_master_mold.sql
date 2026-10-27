ALTER TYPE "public"."outbox_status" ADD VALUE 'dead';--> statement-breakpoint
ALTER TABLE "outbox" ADD COLUMN "last_error" text;--> statement-breakpoint
ALTER TABLE "outbox" ADD COLUMN "failed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "outbox" ADD COLUMN "replays" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE INDEX "outbox_dead_idx" ON "outbox" USING btree ("failed_at") WHERE "outbox"."failed_at" is not null;