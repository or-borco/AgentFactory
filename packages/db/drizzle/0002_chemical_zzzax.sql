ALTER TABLE "messages" ADD COLUMN "run_id" integer;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "triggering_message_id" integer;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_triggering_message_id_messages_id_fk" FOREIGN KEY ("triggering_message_id") REFERENCES "public"."messages"("id") ON DELETE set null ON UPDATE no action;