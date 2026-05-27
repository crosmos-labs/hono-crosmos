import {
  edges,
  entities,
  ingestionJobs,
  memories,
  sources,
} from '@crosmos/db';
import type { TenantScope } from '@crosmos/types';
import { and, eq, type SQL } from 'drizzle-orm';

export type { TenantScope } from '@crosmos/types';

/**
 * Scope filter helpers. Rule: every read/write against org-scoped tables
 * must go through one of these — never write `eq(memories.orgId, ...)`
 * inline. Mirrors Python's `app/engine/tenant/filters.py`.
 *
 * Returned `SQL` chunks are meant to be passed to `.where(scopeX(scope))`,
 * or combined with extra conditions via Drizzle's `and(scopeX(scope), ...)`.
 *
 * See .codex/stack-and-practices.md.
 */
export function scopeSources(scope: TenantScope): SQL {
  return and(eq(sources.orgId, scope.orgId), eq(sources.spaceId, scope.spaceId))!;
}

export function scopeMemories(scope: TenantScope): SQL {
  return and(eq(memories.orgId, scope.orgId), eq(memories.spaceId, scope.spaceId))!;
}

export function scopeEntities(scope: TenantScope): SQL {
  return and(eq(entities.orgId, scope.orgId), eq(entities.spaceId, scope.spaceId))!;
}

export function scopeEdges(scope: TenantScope): SQL {
  return and(eq(edges.orgId, scope.orgId), eq(edges.spaceId, scope.spaceId))!;
}

export function scopeIngestionJobs(scope: TenantScope): SQL {
  return and(
    eq(ingestionJobs.orgId, scope.orgId),
    eq(ingestionJobs.spaceId, scope.spaceId),
  )!;
}
