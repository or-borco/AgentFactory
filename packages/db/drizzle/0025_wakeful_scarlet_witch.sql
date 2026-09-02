CREATE TYPE "public"."context_item_kind" AS ENUM('team', 'task');--> statement-breakpoint
ALTER TABLE "run_context_retrievals" DROP CONSTRAINT "run_context_retrievals_item_id_team_context_items_id_fk";--> statement-breakpoint
ALTER TABLE "run_context_retrievals" ADD COLUMN "item_kind" "context_item_kind" DEFAULT 'team' NOT NULL;
