-- Custom SQL migration file, put your code below! --

-- team_context_items is about to gain NOT NULL columns with no default (org_id, sha256, mime),
-- which Postgres only allows on an empty table. Nothing has ever written to this table outside
-- seed.ts: the POST route that could had zero callers repo-wide, and the three seeded rows
-- describe files that do not exist and can never be ingested. drizzle-kit cannot emit a DELETE,
-- which is what --custom is for.
DELETE FROM team_context_items;