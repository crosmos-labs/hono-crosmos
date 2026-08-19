import { describe, expect, test } from 'bun:test';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

const featuresDir = join(import.meta.dir, '../src/features');
const persistenceBuilder = /\.(select|insert|update|delete|transaction)\s*\(/;

describe('feature route boundaries', () => {
  test('route modules delegate persistence to feature services or operations', async () => {
    const featureNames = await readdir(featuresDir);
    const violations: string[] = [];

    for (const featureName of featureNames) {
      const routePath = join(featuresDir, featureName, 'routes.ts');
      const routeFile = Bun.file(routePath);
      if (!(await routeFile.exists())) continue;
      if (persistenceBuilder.test(await routeFile.text())) violations.push(featureName);
    }

    expect(violations).toEqual([]);
  });
});
