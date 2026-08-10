ALTER TABLE "agents" ADD COLUMN "on_context_overflow" text DEFAULT 'fallback' NOT NULL;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "model" jsonb;