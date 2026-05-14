import { apiKeys, users, type ApiKey, type User } from '@crosmos/db';
import type { Database } from '@crosmos/db';
import { generateApiKey, hashApiKey } from '@crosmos/auth';
import { and, desc, eq } from 'drizzle-orm';

export interface CreatedApiKey {
  apiKey: ApiKey;
  rawKey: string;
}

export async function createApiKey(
  db: Database,
  input: {
    userId: number;
    orgId: number;
    name: string;
    expiresAt?: Date | null;
  },
): Promise<CreatedApiKey> {
  const { rawKey, keyHash, keyPrefix } = await generateApiKey();
  const [row] = await db
    .insert(apiKeys)
    .values({
      userId: input.userId,
      orgId: input.orgId,
      name: input.name,
      keyHash,
      keyPrefix,
      expiresAt: input.expiresAt ?? null,
    })
    .returning();
  if (!row) throw new Error('Failed to create API key');
  return { apiKey: row, rawKey };
}

export async function listApiKeysForUser(
  db: Database,
  userId: number,
): Promise<ApiKey[]> {
  return db
    .select()
    .from(apiKeys)
    .where(eq(apiKeys.userId, userId))
    .orderBy(desc(apiKeys.createdAt));
}

export async function getApiKeyByUuid(
  db: Database,
  userId: number,
  keyUuid: string,
): Promise<ApiKey | null> {
  const rows = await db
    .select()
    .from(apiKeys)
    .where(and(eq(apiKeys.uuid, keyUuid), eq(apiKeys.userId, userId)))
    .limit(1);
  return rows[0] ?? null;
}

export async function revokeApiKey(
  db: Database,
  userId: number,
  keyUuid: string,
): Promise<ApiKey | null> {
  const [row] = await db
    .update(apiKeys)
    .set({ isActive: false, updatedAt: new Date() })
    .where(and(eq(apiKeys.uuid, keyUuid), eq(apiKeys.userId, userId)))
    .returning();
  return row ?? null;
}

export interface ResolvedApiKey {
  apiKey: ApiKey;
  user: User;
}

export async function resolveApiKeyByHash(
  db: Database,
  keyHash: string,
): Promise<ResolvedApiKey | null> {
  const rows = await db
    .select({ apiKey: apiKeys, user: users })
    .from(apiKeys)
    .innerJoin(users, eq(apiKeys.userId, users.id))
    .where(and(eq(apiKeys.keyHash, keyHash), eq(apiKeys.isActive, true)))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  if (!row.user.isActive) return null;
  return row;
}

export async function resolveApiKey(
  db: Database,
  rawKey: string,
): Promise<ResolvedApiKey | null> {
  const keyHash = await hashApiKey(rawKey);
  return resolveApiKeyByHash(db, keyHash);
}

export async function touchApiKeyLastUsed(
  db: Database,
  apiKeyId: number,
): Promise<void> {
  await db
    .update(apiKeys)
    .set({ lastUsedAt: new Date() })
    .where(eq(apiKeys.id, apiKeyId));
}
