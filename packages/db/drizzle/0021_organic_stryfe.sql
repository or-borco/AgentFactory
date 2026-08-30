CREATE TYPE "public"."context_item_status" AS ENUM('pending', 'indexing', 'indexed', 'failed');--> statement-breakpoint
ALTER TABLE "team_context_items" ADD COLUMN "org_id" integer NOT NULL;--> statement-breakpoint
ALTER TABLE "team_context_items" ADD COLUMN "sha256" text NOT NULL;--> statement-breakpoint
ALTER TABLE "team_context_items" ADD COLUMN "mime" text NOT NULL;--> statement-breakpoint
ALTER TABLE "team_context_items" ADD COLUMN "source" text DEFAULT 'upload' NOT NULL;--> statement-breakpoint
ALTER TABLE "team_context_items" ADD COLUMN "status" "context_item_status" DEFAULT 'pending' NOT NULL;--> statement-breakpoint
ALTER TABLE "team_context_items" ADD COLUMN "error" text;--> statement-breakpoint
ALTER TABLE "team_context_items" ADD COLUMN "indexed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "team_context_items" ADD COLUMN "uploaded_by" integer;--> statement-breakpoint
ALTER TABLE "team_context_items" ADD CONSTRAINT "team_context_items_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_context_items" ADD CONSTRAINT "team_context_items_uploaded_by_users_id_fk" FOREIGN KEY ("uploaded_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_context_items" ADD CONSTRAINT "team_context_items_org_id_sha256_content_blobs_org_id_sha256_fk" FOREIGN KEY ("org_id","sha256") REFERENCES "public"."content_blobs"("org_id","sha256") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "team_context_items_team_sha" ON "team_context_items" USING btree ("team_id","sha256");