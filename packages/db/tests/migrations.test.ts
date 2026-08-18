import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';

const migrationsDir = new URL('../migrations/', import.meta.url);
const journal = JSON.parse(
  readFileSync(new URL('meta/_journal.json', migrationsDir), 'utf8'),
) as { entries: Array<{ idx: number; tag: string }> };
const files = new Set(readdirSync(migrationsDir));
const snapshots = new Set(readdirSync(new URL('meta/', migrationsDir)));

describe('Drizzle migration chain', () => {
  test('has SQL and a committed snapshot for every journal entry', () => {
    for (const entry of journal.entries) {
      expect(files.has(`${entry.tag}.sql`)).toBeTrue();
      expect(snapshots.has(`${String(entry.idx).padStart(4, '0')}_snapshot.json`)).toBeTrue();
    }
  });

  test('contains no empty executable migration', () => {
    for (const entry of journal.entries) {
      const sql = readFileSync(new URL(`${entry.tag}.sql`, migrationsDir), 'utf8');
      expect(sql.trim().length).toBeGreaterThan(0);
    }
  });
});
