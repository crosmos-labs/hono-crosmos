import { describe, expect, test } from 'bun:test';
import { awaitSearchAdmission } from '../src/features/search/admission';

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe('search admission join', () => {
  test('does not start provider work until both admission checks pass', async () => {
    const plan = deferred();
    const quota = deferred();
    let providerCalls = 0;

    const request = awaitSearchAdmission(plan.promise, quota.promise).then(
      (outcome) => {
        if (outcome.accepted) providerCalls += 1;
        return outcome;
      },
    );

    plan.resolve();
    await Promise.resolve();
    expect(providerCalls).toBe(0);

    quota.resolve();
    expect(await request).toEqual({ accepted: true });
    expect(providerCalls).toBe(1);
  });

  test('waits for the peer gate and preserves plan-limit error precedence', async () => {
    const plan = deferred();
    const quota = deferred();
    const planError = new Error('plan rejected');
    const quotaError = new Error('quota rejected');
    let settled = false;

    const request = awaitSearchAdmission(plan.promise, quota.promise).then(
      (outcome) => {
        settled = true;
        return outcome;
      },
    );
    plan.reject(planError);
    await Promise.resolve();
    expect(settled).toBe(false);

    quota.reject(quotaError);
    const outcome = await request;
    expect(outcome).toEqual({
      accepted: false,
      stage: 'plan_rate_limit',
      reason: planError,
    });
  });

  test('reports quota failure after a successful plan check', async () => {
    const quotaError = new Error('quota rejected');
    const outcome = await awaitSearchAdmission(
      Promise.resolve(),
      Promise.reject(quotaError),
    );
    expect(outcome).toEqual({
      accepted: false,
      stage: 'monthly_quota',
      reason: quotaError,
    });
  });
});
