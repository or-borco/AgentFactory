CREATE INDEX "events_run_id_seq_idx" ON "events" USING btree ("run_id","seq");--> statement-breakpoint
CREATE INDEX "messages_session_id_idx" ON "messages" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "runs_session_id_idx" ON "runs" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "sessions_agent_id_idx" ON "sessions" USING btree ("agent_id");--> statement-breakpoint
CREATE INDEX "tasks_session_id_idx" ON "tasks" USING btree ("session_id");