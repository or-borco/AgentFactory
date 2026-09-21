// Load .env first, then .env.local as an override so local secrets (CONNECTION_SECRET_KEY, etc.)
// take priority. This mirrors Next.js's own file loading order — the worker uses plain dotenv
// which doesn't do this automatically, so we replicate it here.
import { config } from "dotenv";
config();
config({ path: ".env.local", override: true });
