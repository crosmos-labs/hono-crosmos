import { users, type User, type NewUser } from '@crosmos/db';
import { eq } from 'drizzle-orm';
import type { Database } from '@crosmos/db';

export async function getUserById(
  db: Database,
  userId: number,
): Promise<User | null> {
  const rows = await db.select().from(users).where(eq(users.id, userId)).limit(1);
  return rows[0] ?? null;
}

export async function getUserByEmail(
  db: Database,
  email: string,
): Promise<User | null> {
  const rows = await db.select().from(users).where(eq(users.email, email)).limit(1);
  return rows[0] ?? null;
}

export async function getUserByOauth(
  db: Database,
  provider: string,
  providerId: string,
): Promise<User | null> {
  const rows = await db
    .select()
    .from(users)
    .where(eq(users.oauthProvider, provider))
    .limit(20);
  for (const row of rows) {
    if (row.oauthProviderId === providerId) return row;
  }
  return null;
}

export async function createUser(db: Database, input: NewUser): Promise<User> {
  const [row] = await db.insert(users).values(input).returning();
  if (!row) throw new Error('Failed to create user');
  return row;
}

export async function updateUserName(
  db: Database,
  userId: number,
  name: string,
): Promise<User | null> {
  const [row] = await db
    .update(users)
    .set({ name, updatedAt: new Date() })
    .where(eq(users.id, userId))
    .returning();
  return row ?? null;
}
