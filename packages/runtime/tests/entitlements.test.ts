import { describe, expect, test } from 'bun:test';
import { activeGrantedPlan, resolveEntitlements } from '../src';

const organization = (expiresAt: Date | null) => ({
  plan: 'free',
  grantedPlan: expiresAt ? 'pro' : null,
  grantedPlanExpiresAt: expiresAt,
  entitlements: { max_graph_depth: 2 },
});

describe('shared entitlement resolution', () => {
  test('uses an unexpired grant and applies explicit overrides last', () => {
    const now = new Date('2026-08-14T00:00:00Z');
    const org = organization(new Date('2026-08-15T00:00:00Z'));
    expect(activeGrantedPlan(org, now)).toBe('pro');
    expect(resolveEntitlements(org, now)).toMatchObject({
      monthly_tokens_ingested: 40_000_000,
      max_graph_depth: 2,
    });
  });

  test('falls back at read time once the grant expires', () => {
    const now = new Date('2026-08-14T00:00:00Z');
    const org = organization(new Date('2026-08-13T00:00:00Z'));
    expect(activeGrantedPlan(org, now)).toBeNull();
    expect(resolveEntitlements(org, now).monthly_tokens_ingested).toBe(500_000);
  });
});
