/**
 * TEMPORARY benchmark/ops tool — re-embeds an existing space's memories and
 * entities with the currently-configured embedder and upserts the vectors into
 * the (vectorize) store. Used to repopulate a freshly-recreated Vectorize index
 * after switching embedding provider/dimension (e.g. bge-m3 1024 →
 * text-embedding-3-small 1536) WITHOUT re-running LLM extraction.
 *
 * Gated behind `ADMIN_TOOLS === 'true'` (off by default) AND org owner role.
 * Mirrors ingestion's embed text: memory = `content (happened in <Month YYYY>)`
 * when event_time is set, entity = `name`.
 */
import { entities, memories, memorySpaces } from '@crosmos/db';
import { createLogger, durationMs } from '@crosmos/observability';
import { and, eq, isNull } from 'drizzle-orm';
import { HTTPException } from 'hono/http-exception';
import { createApiApp } from '../../lib/openapi';
import { getDb } from '../../db';
import { getEmbedder } from '../../integrations/embeddings';
import { getVectorStore } from '../../integrations/vector-store';
import { requireAuth } from '../auth/middleware';
import { requirePrincipal } from '../auth/principal';

export const adminRoutes = createApiApp();

const EMBED_BATCH = 96;

function memoryText(content: string, eventTime: Date | null): string {
  if (!eventTime) return content;
  const month = eventTime.toLocaleString('en-US', {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });
  return `${content} (happened in ${month})`;
}

adminRoutes.post('/reembed', requireAuth, requirePrincipal, async (c) => {
  if ((c.env as { ADMIN_TOOLS?: string }).ADMIN_TOOLS !== 'true') {
    throw new HTTPException(404, { message: 'Not found' });
  }
  if (c.var.orgRole !== 'owner') {
    throw new HTTPException(403, { message: 'Owner only' });
  }
  const body = await c.req.json<{ space_id: string }>();
  const db = getDb(c);
  const orgId = c.var.activeOrgId!;
  const logger = createLogger({ service: 'api', environment: c.env.ENVIRONMENT });

  const [space] = await db
    .select({ id: memorySpaces.id, orgId: memorySpaces.orgId })
    .from(memorySpaces)
    .where(eq(memorySpaces.uuid, body.space_id))
    .limit(1);
  if (!space || space.orgId !== orgId) {
    throw new HTTPException(404, { message: 'Space not found' });
  }

  const embedder = getEmbedder(c.env);
  const vectorStore = getVectorStore(c.env, db);
  const t0 = performance.now();

  // --- memories ---
  const memRows = await db
    .select({ id: memories.id, content: memories.content, eventTime: memories.eventTime })
    .from(memories)
    .where(and(eq(memories.orgId, orgId), eq(memories.spaceId, space.id), isNull(memories.forgottenAt)));

  let memEmbedded = 0;
  for (let i = 0; i < memRows.length; i += EMBED_BATCH) {
    const batch = memRows.slice(i, i + EMBED_BATCH);
    const { vectors } = await embedder.embedBatch(
      batch.map((m) => memoryText(m.content, m.eventTime)),
      { mode: 'document' },
    );
    await vectorStore.upsert(
      'memories',
      batch.map((m, j) => ({ id: m.id, vector: vectors[j]!, orgId, spaceId: space.id })),
    );
    memEmbedded += batch.length;
  }

  // --- entities ---
  const entRows = await db
    .select({ id: entities.id, name: entities.name })
    .from(entities)
    .where(and(eq(entities.orgId, orgId), eq(entities.spaceId, space.id)));

  let entEmbedded = 0;
  for (let i = 0; i < entRows.length; i += EMBED_BATCH) {
    const batch = entRows.slice(i, i + EMBED_BATCH);
    const { vectors } = await embedder.embedBatch(
      batch.map((e) => e.name),
      { mode: 'document' },
    );
    await vectorStore.upsert(
      'entities',
      batch.map((e, j) => ({ id: e.id, vector: vectors[j]!, orgId, spaceId: space.id })),
    );
    entEmbedded += batch.length;
  }

  const duration = durationMs(t0);
  logger.info('admin.reembed_completed', {
    space_id: space.id,
    memory_count: memEmbedded,
    entity_count: entEmbedded,
    duration_ms: duration,
  });

  return c.json({
    space_id: body.space_id,
    dimensions: embedder.dimensions,
    memories_embedded: memEmbedded,
    entities_embedded: entEmbedded,
    duration_ms: duration,
  });
});
