/**
 * P1-H — persisted speaker attribution.
 *
 * The extraction prompt has always produced `speaker_role` and the cross-chunk
 * dedup key has always included it, but the memory insert dropped it, so the
 * signal was computed and discarded on every ingest. This pins the column's
 * round-trip behavior and, more importantly, that adding it changed nothing:
 * historical rows stay valid as null, and the retrieval projection is untouched.
 */
import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { type Database, memories } from '@crosmos/db';
import { eq, sql } from 'drizzle-orm';
import { retrievalMemoryColumns } from '../src/features/search/candidates';
import {
  announceSkip,
  getTestDb,
  resetTestData,
  seedTenant,
  type Tenant,
} from './helpers/test-db';

const db: Database | null = await getTestDb();
if (db === null) announceSkip('speaker-role.pg.test.ts');
const describeDb = db === null ? describe.skip : describe;

let tenant: Tenant;

afterAll(async () => {
  if (db !== null) await resetTestData(db);
});

beforeEach(async () => {
  if (db === null) return;
  await resetTestData(db);
  tenant = await seedTenant(db);
});

async function insertMemory(speakerRole: string | null): Promise<number> {
  const [row] = await db!
    .insert(memories)
    .values({
      orgId: tenant.orgId,
      spaceId: tenant.spaceId,
      ownerUserId: tenant.userId,
      visibility: 'org',
      content: `fact with role ${speakerRole ?? 'none'}`,
      memoryType: 'semantic',
      speakerRole,
      importanceScore: 0.5,
      recordedAt: new Date(),
    })
    .returning({ id: memories.id });
  return row!.id;
}

describeDb('memories.speaker_role', () => {
  test.each(['user', 'assistant', 'system', 'tool'])(
    '%s round-trips exactly',
    async (role) => {
      const id = await insertMemory(role);
      const [row] = await db!
        .select({ speakerRole: memories.speakerRole })
        .from(memories)
        .where(eq(memories.id, id));
      expect(row!.speakerRole).toBe(role);
    },
  );

  test('null round-trips as null, not an empty string', async () => {
    const id = await insertMemory(null);
    const [row] = await db!
      .select({ speakerRole: memories.speakerRole })
      .from(memories)
      .where(eq(memories.id, id));
    expect(row!.speakerRole).toBeNull();
  });

  test('a row written without the field at all is valid and null', async () => {
    // Exactly what every historical row looks like after the migration, and
    // what an older Worker build still deployed would write.
    await db!.execute(sql`
      insert into memories (uuid, org_id, space_id, owner_user_id, visibility,
                            content, memory_type, importance_score, recorded_at)
      values (gen_random_uuid(), ${tenant.orgId}, ${tenant.spaceId},
              ${tenant.userId}, 'org', 'legacy row', 'semantic', 0.5, now())`);

    const [row] = await db!
      .select({ speakerRole: memories.speakerRole })
      .from(memories);
    expect(row!.speakerRole).toBeNull();
  });

  test('the column is nullable, unconstrained and length-bounded', async () => {
    const [col] = await db!.execute<{
      is_nullable: string;
      data_type: string;
      character_maximum_length: number;
    }>(sql`
      select is_nullable, data_type, character_maximum_length
      from information_schema.columns
      where table_name = 'memories' and column_name = 'speaker_role'`);

    expect(col).toBeDefined();
    expect(col!.is_nullable).toBe('YES');
    expect(col!.data_type).toBe('character varying');
    expect(col!.character_maximum_length).toBe(16);
  });

  test('retrieval does not read it — the projection is unchanged', () => {
    // Adding the column must not widen what search pulls out of Postgres.
    expect(Object.keys(retrievalMemoryColumns)).not.toContain('speakerRole');
  });
});
