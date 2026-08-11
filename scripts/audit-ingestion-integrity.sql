-- Read-only ingestion-integrity audit (checklist P0-B, "Existing-data audit
-- required before rollout").
--
--   psql "$DATABASE_URL" -f scripts/audit-ingestion-integrity.sql
--
-- Strictly SELECT-only. It reports; it never repairs. That restriction is
-- deliberate: a memory whose `chunk_memories` link is gone cannot always be
-- attributed to a source afterwards, so an automatic cleanup risks deleting
-- real user data, and a blanket re-ingest DUPLICATES the orphans because the
-- purge can no longer tell which source owned them.
--
-- READING THE RESULTS — two of the checks the checklist proposes produce false
-- positives against this schema, because `ingestSource` skips the chunk insert
-- entirely when a chunk yields no facts (`if (facts.length === 0) return []`):
--
--   * "completed source with zero chunks" simply means every chunk of that
--     source yielded no extractable facts. Normal for short chit-chat.
--   * "sequence gaps" mean SOME chunks yielded facts and others did not. Also
--     normal — sequence numbers come from the chunk plan, not from what
--     survived extraction.
--
-- Only check 1 (orphaned memories) is evidence of the purge bug. Checks 2 and 3
-- are kept because a sudden CHANGE in them is still worth noticing, but their
-- absolute values are not defects.

\pset pager off

\echo ''
\echo '=== 1. Memories with no chunk_memories link (REAL signal) ==='
\echo '    The casualty shape of the pre-2026-08-11 purge bug: the memory'
\echo '    survived while its citation was cascaded away with the chunk.'
\echo '    Also produced legitimately by deleting a source (chunks cascade,'
\echo '    memories do not), so correlate with dates before concluding.'
SELECT count(*) AS orphaned_memories FROM memories m
WHERE NOT EXISTS (SELECT 1 FROM chunk_memories cm WHERE cm.memory_id = m.id);

SELECT date_trunc('day', m.created_at)::date AS day, count(*) AS orphans
FROM memories m
WHERE NOT EXISTS (SELECT 1 FROM chunk_memories cm WHERE cm.memory_id = m.id)
GROUP BY day ORDER BY day;

\echo ''
\echo '    Impact check: are they still retrievable, and do they keep their'
\echo '    graph signal? An orphan is DEGRADED (no `source` in the API'
\echo '    response), not lost, as long as forgotten_at is null.'
SELECT count(*) AS total,
       count(*) FILTER (WHERE forgotten_at IS NULL) AS retrievable,
       (SELECT count(*) FROM memory_entities me WHERE me.memory_id IN
          (SELECT m2.id FROM memories m2 WHERE NOT EXISTS
             (SELECT 1 FROM chunk_memories cm WHERE cm.memory_id = m2.id))) AS entity_links,
       (SELECT count(*) FROM edges e WHERE e.memory_id IN
          (SELECT m2.id FROM memories m2 WHERE NOT EXISTS
             (SELECT 1 FROM chunk_memories cm WHERE cm.memory_id = m2.id))) AS edges
FROM memories m
WHERE NOT EXISTS (SELECT 1 FROM chunk_memories cm WHERE cm.memory_id = m.id);

\echo ''
\echo '=== 2. Completed sources with zero chunks (EXPECTED — see header) ==='
SELECT count(*) AS completed_sources_with_zero_chunks
FROM sources s
WHERE s.extraction_status = 'completed'
  AND NOT EXISTS (SELECT 1 FROM chunks c WHERE c.source_id = s.id);

\echo ''
\echo '=== 3. Sources with chunk-sequence gaps (EXPECTED — see header) ==='
SELECT count(*) AS sources_with_sequence_gaps FROM (
  SELECT c.source_id FROM chunks c GROUP BY c.source_id
  HAVING max(c.sequence) + 1 <> count(*)
) g;

\echo ''
\echo '=== 4. Checkpoint ahead of persisted chunks (REAL signal) ==='
\echo '    ingest_next_sequence claiming more progress than exists would mean'
\echo '    the resumable pipeline lost committed work. Must be 0.'
SELECT count(*) AS checkpoint_ahead_of_chunks
FROM sources s
WHERE (s.meta->>'ingest_next_sequence') IS NOT NULL
  AND (s.meta->>'ingest_next_sequence')::int
      > coalesce((SELECT count(*) FROM chunks c WHERE c.source_id = s.id), 0);

\echo ''
\echo '=== 5. Sources stuck non-terminal (REAL signal) ==='
\echo '    `processing` long after any live lease means a run died without the'
\echo '    redrive sweep recovering it.'
SELECT extraction_status, count(*) AS sources,
       min(created_at)::date AS oldest
FROM sources
WHERE extraction_status IN ('pending', 'processing')
GROUP BY extraction_status ORDER BY extraction_status;

\echo ''
\echo '=== 6. Tombstoned spaces awaiting finalization (P1-A backlog) ==='
\echo '    Grows without bound while SPACE_FINALIZER_ENABLED is unset.'
SELECT count(*) AS tombstoned_spaces,
       min(deleted_at) AS oldest_tombstone
FROM memory_spaces WHERE deleted_at IS NOT NULL;
