import { z } from '@hono/zod-openapi';
import { IsoDateTimeSchema, UuidSchema } from '../../lib/zod-common';

export const GraphNodeSchema = z
  .object({
    id: UuidSchema,
    name: z.string(),
    entity_type: z.string().nullable(),
    edge_count: z.number().int(),
    created_at: IsoDateTimeSchema.nullable(),
    updated_at: IsoDateTimeSchema.nullable(),
  })
  .openapi('GraphNode');

export const GraphEdgeSchema = z
  .object({
    id: UuidSchema,
    source_entity_id: UuidSchema,
    target_entity_id: UuidSchema,
    relation_type: z.string(),
    confidence: z.number(),
    valid_from: IsoDateTimeSchema.nullable(),
    recorded_at: IsoDateTimeSchema,
  })
  .openapi('GraphEdge');

export const GraphViewportResponseSchema = z
  .object({
    nodes: z.array(GraphNodeSchema),
    edges: z.array(GraphEdgeSchema),
    total_nodes: z.number().int().nonnegative(),
    total_edges: z.number().int().nonnegative(),
  })
  .openapi('GraphViewportResponse');

export const GraphStatsResponseSchema = z
  .object({
    total_entities: z.number().int().nonnegative(),
    total_edges: z.number().int().nonnegative(),
    entity_types: z.record(z.number().int()),
    top_relations: z.array(
      z.object({ relation: z.string(), count: z.number().int() }),
    ),
  })
  .openapi('GraphStatsResponse');

export const GraphViewportQuerySchema = z
  .object({
    space_id: UuidSchema,
    limit: z.coerce.number().int().min(1).max(500).default(100),
    offset: z.coerce.number().int().min(0).default(0),
  })
  .openapi('GraphViewportQuery');

export const GraphStatsQuerySchema = z
  .object({ space_id: UuidSchema })
  .openapi('GraphStatsQuery');
