DROP INDEX "sessions_org_origin_external_thread_idx";--> statement-breakpoint
ALTER TABLE "channel_authorized_users" ADD COLUMN "active_task_id" integer;--> statement-breakpoint
ALTER TABLE "channel_authorized_users" ADD CONSTRAINT "channel_authorized_users_active_task_id_tasks_id_fk" FOREIGN KEY ("active_task_id") REFERENCES "public"."tasks"("id") ON DELETE set null ON UPDATE no action;