import { z } from '@hono/zod-openapi';
import { PlanSchema } from '../../lib/zod-common';

export const UsageMetricSchema = z
  .object({
    used: z.number().int(),
    limit: z.number().int(),
    remaining: z.number().int(),
  })
  .openapi('UsageMetric');

export const UsageResponseSchema = z
  .object({
    plan: PlanSchema,
    period_start: z.string().date(),
    period_end: z.string().date(),
    tokens: UsageMetricSchema,
    queries: UsageMetricSchema,
    spaces: UsageMetricSchema,
    rate_limit_rpm: z.number().int(),
    rate_limit_per_day: z.number().int(),
  })
  .openapi('UsageResponse');

export const UsageQuerySchema = z
  .object({
    start_date: z.string().date().optional(),
    end_date: z.string().date().optional(),
  })
  .openapi('UsageQuery');
