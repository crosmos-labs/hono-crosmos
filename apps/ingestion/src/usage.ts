/**
 * `daily_usage` upsert — recorded once per job at the terminal transition.
 * Mirrors Python's `record_ingestion_tokens` and the producer-side copy in
 * `apps/api/src/features/usage/service.ts`.
 */
import { dailyUsage, type Database } from '@crosmos/db';
import type { TenantScope } from '@crosmos/types';
import { sql } from 'drizzle-orm';

export async function recordIngestionTokens(
  db: Database,
  scope: TenantScope,
  tokens: number,
): Promise<void> {
  if (tokens <= 0) return;
  await db
    .insert(dailyUsage)
    .values({
      orgId: scope.orgId,
      userId: scope.userId,
      spaceId: scope.spaceId,
      date: sql`current_date`,
      tokensIngested: tokens,
      searchQueries: 0,
    })
    .onConflictDoUpdate({
      target: [
        dailyUsage.orgId,
        dailyUsage.userId,
        dailyUsage.spaceId,
        dailyUsage.date,
      ],
      set: {
        tokensIngested: sql`${dailyUsage.tokensIngested} + ${tokens}`,
        updatedAt: new Date(),
      },
    });
}
