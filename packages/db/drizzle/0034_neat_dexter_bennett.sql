CREATE TYPE "public"."pr_review_status" AS ENUM('pending', 'posted', 'discarded');--> statement-breakpoint
ALTER TABLE "pr_reviews" ALTER COLUMN "posted_as" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "pr_reviews" ALTER COLUMN "github_review_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "pr_reviews" ALTER COLUMN "url" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "pr_reviews" ADD COLUMN "status" "pr_review_status" DEFAULT 'pending' NOT NULL;--> statement-breakpoint
-- Pre-existing rows predate the "GitHub is no longer the source of truth for review content"
-- redesign: they were posted straight to GitHub with no summary ever persisted locally. Mark them
-- posted (they're already live) and backfill an empty summary so the NOT NULL below can succeed.
UPDATE "pr_reviews" SET "status" = 'posted' WHERE "github_review_id" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "pr_reviews" ADD COLUMN "summary" text;--> statement-breakpoint
UPDATE "pr_reviews" SET "summary" = '' WHERE "summary" IS NULL;--> statement-breakpoint
ALTER TABLE "pr_reviews" ALTER COLUMN "summary" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "pr_reviews" ADD COLUMN "comments" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "agents" DROP COLUMN "role";--> statement-breakpoint
DROP TYPE "public"."agent_role";