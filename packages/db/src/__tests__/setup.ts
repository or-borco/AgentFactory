import { fileURLToPath } from "node:url";
import path from "node:path";
import { config as loadEnv } from "dotenv";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { afterAll, afterEach, beforeAll } from "vitest";

const dir = path.dirname(fileURLToPath(import.meta.url));

// Local dev: copy .env.test.example to .env.test.local pointing at a scratch database. In CI,
// DATABASE_URL is already set by the job (see .github/workflows/test.yml) so this is a no-op.
loadEnv({ path: path.resolve(dir, "../../../../.env.test.local"), override: false });

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error(
    "DATABASE_URL is not set. Copy .env.test.example to .env.test.local (pointing at a scratch " +
      "Postgres database) before running `pnpm test:db`.",
  );
}

const migrationClient = postgres(connectionString, { max: 1 });
const migrationDb = drizzle(migrationClient);

// Ordered leaves-first so FK constraints don't block the truncate even without CASCADE, though
// CASCADE is kept as a safety net for any relation added later.
const TABLES_LEAVES_FIRST = [
  "repo_maps",
  "events",
  "runs",
  "messages",
  "tasks",
  "sessions",
  "connections",
  "agents",
  "teams",
  "auth_sessions",
  "memberships",
  "users",
  "orgs",
] as const;

beforeAll(async () => {
  await migrate(migrationDb, { migrationsFolder: path.resolve(dir, "../../drizzle") });
});

afterEach(async () => {
  await migrationClient.unsafe(
    `truncate table ${TABLES_LEAVES_FIRST.join(", ")} restart identity cascade`,
  );
});

afterAll(async () => {
  await migrationClient.end();
});
