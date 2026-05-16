/**
 * Source loader with retries — Stage 0 of the pipeline. Mirrors Python's
 * `_load_source` (5 attempts, 0.5s linear backoff). The retries paper over
 * cases where the producer's INSERT hasn't propagated yet (replica lag).
 */
import { sources, type Database, type Source } from '@crosmos/db';
import { eq } from 'drizzle-orm';
import {
  SOURCE_LOAD_RETRIES,
  SOURCE_LOAD_RETRY_DELAY_MS,
} from '../constants';

export async function loadSource(
  db: Database,
  sourceId: number,
): Promise<Source> {
  let lastErr: unknown = null;
  for (let attempt = 1; attempt <= SOURCE_LOAD_RETRIES; attempt++) {
    try {
      const rows = await db
        .select()
        .from(sources)
        .where(eq(sources.id, sourceId))
        .limit(1);
      if (rows[0]) return rows[0];
    } catch (err) {
      lastErr = err;
    }
    if (attempt < SOURCE_LOAD_RETRIES) {
      await new Promise((r) => setTimeout(r, SOURCE_LOAD_RETRY_DELAY_MS * attempt));
    }
  }
  if (lastErr) throw lastErr;
  throw new Error(`Source ${sourceId} not found after ${SOURCE_LOAD_RETRIES} attempts`);
}
