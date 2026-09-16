CREATE TYPE "public"."agent_role" AS ENUM('developer', 'reviewer');--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "role" "agent_role" DEFAULT 'developer' NOT NULL;