import { fileURLToPath } from "node:url";
import path from "node:path";
import { config as loadEnv } from "dotenv";

const dir = path.dirname(fileURLToPath(import.meta.url));

// Local dev: copy .env.test.example to .env.test.local pointing at a scratch Redis instance. In
// CI, REDIS_URL is already set by the job (see .github/workflows/test.yml) so this is a no-op.
loadEnv({ path: path.resolve(dir, "../../../../.env.test.local"), override: false });

if (!process.env.REDIS_URL) {
  throw new Error(
    "REDIS_URL is not set. Copy .env.test.example to .env.test.local (pointing at a scratch " +
      "Redis instance) before running `pnpm test:queue`.",
  );
}
