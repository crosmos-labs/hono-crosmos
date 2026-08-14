import { describe, expect, test } from 'bun:test';
import type { Organization } from '@crosmos/db';
import { activeGrantedPlan, resolveEntitlements } from '../src/features/orgs/entitlements';

function org(expiresAt: Date | null): Organization {
  return {
    plan: 'free', grantedPlan: expiresAt ? 'pro' : null,
    grantedPlanExpiresAt: expiresAt, entitlements: { max_graph_depth: 2 },
  } as Organization;
}

describe('time-boxed plan grants', () => {
  const now = new Date('2026-08-14T00:00:00Z');
  test('uses a live grant while merging bespoke overrides on top', () => {
    const value = org(new Date('2026-08-15T00:00:00Z'));
    expect(activeGrantedPlan(value, now)).toBe('pro');
    const entitlements = resolveEntitlements(value, now);
    expect(entitlements.monthly_tokens_ingested).toBe(40_000_000);
    expect(entitlements.max_graph_depth).toBe(2);
  });
  test('expires at read time without waiting for the sweep', () => {
    const value = org(new Date('2026-08-13T00:00:00Z'));
    expect(activeGrantedPlan(value, now)).toBeNull();
    expect(resolveEntitlements(value, now).monthly_tokens_ingested).toBe(500_000);
  });
});
