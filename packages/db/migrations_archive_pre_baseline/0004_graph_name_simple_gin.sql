-- Graph name-seed: indexed exact-word lookup on entity names so the seed no
-- longer scans every in-scope entity per /search. The `simple` text-search
-- config does NO stemming and NO stopword removal, so an index match is a
-- faithful SUPERSET of the JS token-overlap the seed computes (every JS
-- name-token is also a `simple` lexeme) — the seed then applies its exact
-- overlap math over the bounded candidate set, so ranking is unchanged.
-- Distinct from "entities_name_gin_idx" (english config) used elsewhere.
CREATE INDEX IF NOT EXISTS "entities_name_simple_gin_idx" ON "entities" USING gin (to_tsvector('simple', "name"));
