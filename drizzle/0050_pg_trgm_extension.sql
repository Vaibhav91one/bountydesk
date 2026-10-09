-- The duplicate-candidate matcher (lib/triage/duplicates.ts) wants a text-similarity signal
-- richer than its word-set Jaccard overlap, for a paraphrase that shares few exact words. pg_trgm
-- is the lazy-correct first step: a Postgres built-in, zero new infrastructure, no external
-- service. Upgrade to embeddings only if this measurably misses (see #347).
CREATE EXTENSION IF NOT EXISTS pg_trgm;
