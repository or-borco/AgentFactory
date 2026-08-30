-- Hand-written because drizzle-kit cannot emit CREATE EXTENSION (`generate --custom` is the
-- sanctioned escape hatch for exactly this). The vector type must exist before any migration
-- that declares a vector(384) column. Requires the pgvector/pgvector:pg16 image — the extension
-- is not available in postgres:16-alpine, which is why the image swap is in this same commit.
CREATE EXTENSION IF NOT EXISTS vector;