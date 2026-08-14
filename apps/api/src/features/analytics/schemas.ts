import { z } from '@hono/zod-openapi';

export const AnalyticsQuerySchema = z.object({
  days: z.coerce.number().pipe(z.union([z.literal(30), z.literal(60), z.literal(90)])).default(30),
});

const TotalsSchema = z.object({
  sources_ingested: z.number().int().describe("Sources that reached extraction_status = 'completed' on that day"),
  sources_failed: z.number().int().describe('Sources whose extraction terminally failed on that day'),
  memories_created: z.number().int().describe('Memories persisted by completed extractions on that day'),
  tokens_ingested: z.number().int().describe('Submitted input tokens — the quota basis, not provider throughput'),
  search_queries: z.number().int().describe('Retrieval requests that passed the admission gates'),
});

export const AnalyticsResponseSchema = z.object({
  period_start: z.string(),
  period_end: z.string(),
  days: z.union([z.literal(30), z.literal(60), z.literal(90)]),
  totals: TotalsSchema,
  previous_period_totals: TotalsSchema,
  daily: z.array(TotalsSchema.extend({ date: z.string() })),
  sources_by_content_type: z.array(z.object({ content_type: z.string(), count: z.number().int() })),
  spaces: z.array(z.object({
    space_id: z.string(),
    name: z.string().nullable(),
    totals: TotalsSchema,
  })),
});
