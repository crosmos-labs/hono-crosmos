import {
  edges,
  entities,
  ingestionJobs,
  memories,
  sources,
} from '@crosmos/db';
import type { TenantScope } from '@crosmos/types';
import { and, eq, inArray, isNull, or, sql, type SQL } from 'drizzle-orm';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';

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
function ownerVisibilityClause(
  visibilityColumn: AnyPgColumn,
  ownerColumn: AnyPgColumn,
  scope: TenantScope,
): SQL | undefined {
  if (scope.visibleUserIds == null) return undefined;
  if (scope.visibleUserIds.length === 0) return sql`false`;
  return or(
    eq(visibilityColumn, 'org'),
    inArray(ownerColumn, [...scope.visibleUserIds]),
  )!;
}

export function sourceVisibilityClause(scope: TenantScope): SQL | undefined {
  return ownerVisibilityClause(sources.visibility, sources.ownerUserId, scope);
}

export function memoryVisibilityClause(scope: TenantScope): SQL | undefined {
  return ownerVisibilityClause(memories.visibility, memories.ownerUserId, scope);
}

export function edgeVisibilityClause(scope: TenantScope): SQL | undefined {
  return ownerVisibilityClause(edges.visibility, edges.ownerUserId, scope);
}

/**
 * Graph expansion matches Python's special orphan-edge behavior: ownerless
 * edges are traversable, but generic source/memory/edge reads do not expose
 * NULL-owner rows.
 */
export function graphEdgeVisibilityClause(scope: TenantScope): SQL | undefined {
  const base = edgeVisibilityClause(scope);
  if (base === undefined) return undefined;
  return or(base, isNull(edges.ownerUserId))!;
}

export function scopeSources(scope: TenantScope): SQL {
  return and(
    eq(sources.orgId, scope.orgId),
    eq(sources.spaceId, scope.spaceId),
    sourceVisibilityClause(scope),
  )!;
}

export function scopeMemories(scope: TenantScope): SQL {
  return and(
    eq(memories.orgId, scope.orgId),
    eq(memories.spaceId, scope.spaceId),
    memoryVisibilityClause(scope),
  )!;
}

export function scopeEntities(scope: TenantScope): SQL {
  return and(eq(entities.orgId, scope.orgId), eq(entities.spaceId, scope.spaceId))!;
}

export function scopeEdges(scope: TenantScope): SQL {
  return and(
    eq(edges.orgId, scope.orgId),
    eq(edges.spaceId, scope.spaceId),
    edgeVisibilityClause(scope),
  )!;
}

export function scopeIngestionJobs(scope: TenantScope): SQL {
  return and(
    eq(ingestionJobs.orgId, scope.orgId),
    eq(ingestionJobs.spaceId, scope.spaceId),
  )!;
}
