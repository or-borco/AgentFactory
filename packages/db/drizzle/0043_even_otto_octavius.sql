ALTER TABLE "messages" ADD COLUMN "kind" text;--> statement-breakpoint
UPDATE "messages" SET "kind" = 'task_brief'
WHERE "id" IN (
  SELECT MIN(m."id") FROM "messages" m
  JOIN "tasks" t ON t."session_id" = m."session_id"
  WHERE m."role" = 'user'
  GROUP BY m."session_id"
);