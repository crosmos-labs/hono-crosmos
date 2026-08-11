/**
 * A tiny in-memory stand-in for the Drizzle `Database` handle.
 *
 * Why this exists: the destructive parts of the ingestion pipeline (the
 * idempotency purge in particular) are correctness-critical and their bugs live
 * entirely in *predicate scope* — which rows a `delete().where(...)` actually
 * touches. Asserting on a recorded call list can't catch that: `delete(chunks)
 * .where(eq(sourceId))` and `delete(chunks).where(inArray(id, ids))` look
 * identical unless you evaluate the predicate against real rows.
 *
 * So this fake actually *runs* the predicate. It serializes the Drizzle `SQL`
 * condition with `PgDialect` (the same serializer the real driver uses), then
 * compiles the resulting parameterized string into a JS row predicate. That
 * covers the small predicate vocabulary the pipeline uses (`=`, `>=`, `<=`,
 * `>`, `<`, `in`, `is null`, `is not null`, `and`, `or`, `not`) — enough to make
 * the purge/scoping tests meaningful without standing up Postgres.
 *
 * It is deliberately NOT a general Postgres emulator. If a test needs a
 * predicate shape the compiler rejects, it throws loudly rather than silently
 * matching nothing.
 */
import { getTableColumns, getTableName, type SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { PgTable } from 'drizzle-orm/pg-core';

const dialect = new PgDialect();

export type Row = Record<string, unknown>;

/** `"table"."column"` → the JS property name Drizzle maps it to. */
function columnAliasMap(tables: PgTable[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const table of tables) {
    const name = getTableName(table);
    for (const [jsKey, col] of Object.entries(getTableColumns(table))) {
      map.set(`"${name}"."${(col as { name: string }).name}"`, jsKey);
    }
  }
  return map;
}

/**
 * Compile a serialized predicate into `(row) => boolean`.
 *
 * The transformation is textual but constrained: every column reference must be
 * one of the known `"table"."column"` tokens, and every remaining token must be
 * a recognized operator. Anything else throws.
 */
function compilePredicate(
  condition: SQL,
  aliases: Map<string, string>,
): (row: Row) => boolean {
  const { sql, params } = dialect.sqlToQuery(condition);

  let expr = sql;
  // Column references first, so a column literally named e.g. `in` can't be
  // mangled by the operator rewrites below.
  for (const [token, jsKey] of aliases) {
    expr = expr.split(token).join(`__col(${JSON.stringify(jsKey)})`);
  }
  // `in (...)` is rewritten while the operands are still bare `$n` markers: once
  // they become `__param(0)` the list contains parentheses and the non-greedy
  // `[^)]*` capture below would terminate on the wrong one.
  expr = expr.replace(
    /([^\s(]+(?:\([^)]*\))?)\s+in\s+\(([^)]*)\)/gi,
    '__in($1, [$2])',
  );

  // Positional parameters. Replace highest-index first so `$1` doesn't eat the
  // prefix of `$10`.
  const indices = params.map((_, i) => i + 1).reverse();
  for (const i of indices) {
    expr = expr.split(`$${i}`).join(`__param(${i - 1})`);
  }

  expr = expr
    .replace(/\bis not null\b/gi, '!== __NULL')
    .replace(/\bis null\b/gi, '=== __NULL')
    .replace(/\bnot\b/gi, '!')
    .replace(/\band\b/gi, '&&')
    .replace(/\bor\b/gi, '||')
    .replace(/(?<![<>!=])=(?!=)/g, '===')
    .replace(/<>/g, '!==');

  // Guard: after rewriting, only our helper calls, parentheses, operators,
  // commas and whitespace should remain. Bare identifiers mean an unsupported
  // SQL construct slipped through and would otherwise throw a confusing
  // ReferenceError at match time.
  const residue = expr
    .replace(/__col\([^)]*\)|__param\(\d+\)|__in|__NULL/g, '')
    .replace(/[\s(),[\]&|!<>=+*/-]/g, '');
  if (residue.length > 0) {
    throw new Error(
      `fake-db: unsupported SQL predicate "${sql}" (unhandled tokens: ${residue})`,
    );
  }

  const fn = new Function(
    '__col',
    '__param',
    '__in',
    '__NULL',
    `return ${expr};`,
  ) as (
    col: (k: string) => unknown,
    param: (i: number) => unknown,
    isIn: (v: unknown, list: unknown[]) => boolean,
    nul: null,
  ) => boolean;

  return (row: Row) =>
    fn(
      (k) => (row[k] === undefined ? null : row[k]),
      (i) => params[i],
      (value, list) => list.some((candidate) => candidate === value),
      null,
    );
}

/** Parent → dependents removed when a parent row is deleted. */
export interface CascadeRule {
  /** Table whose rows are removed. */
  table: PgTable;
  /** Column on the dependent table holding the parent key. */
  foreignKey: string;
  /** Column on the parent table the key points at. */
  parentKey: string;
  /**
   * `cascade` deletes the dependent row; `set null` nulls the FK column,
   * matching `ON DELETE SET NULL`.
   */
  action: 'cascade' | 'set null';
}

export interface FakeDbOptions {
  /** Seed rows keyed by table name. */
  tables: { table: PgTable; rows: Row[] }[];
  /** Referential actions applied on delete, keyed by the parent table name. */
  cascades?: Record<string, CascadeRule[]>;
}

export interface RecordedOp {
  kind: 'select' | 'delete';
  table: string;
  /** Rows matched (select) or removed (delete). */
  count: number;
}

/**
 * In-memory database double. `rows(table)` exposes the live table contents so a
 * test can assert on what survived a destructive operation.
 */
export class FakeDb {
  private readonly data = new Map<string, Row[]>();
  private readonly aliases: Map<string, string>;
  private readonly cascades: Record<string, CascadeRule[]>;
  readonly ops: RecordedOp[] = [];

  constructor(options: FakeDbOptions) {
    const tables = options.tables.map((t) => t.table);
    this.aliases = columnAliasMap(tables);
    this.cascades = options.cascades ?? {};
    for (const { table, rows } of options.tables) {
      this.data.set(
        getTableName(table),
        rows.map((r) => ({ ...r })),
      );
    }
  }

  rows(table: PgTable): Row[] {
    return this.data.get(getTableName(table)) ?? [];
  }

  private match(table: PgTable, condition?: SQL): Row[] {
    const rows = this.rows(table);
    if (!condition) return [...rows];
    const predicate = compilePredicate(condition, this.aliases);
    return rows.filter(predicate);
  }

  select(projection: Record<string, unknown>) {
    return {
      from: (table: PgTable) => {
        const run = (condition?: SQL) => {
          const matched = this.match(table, condition);
          this.ops.push({
            kind: 'select',
            table: getTableName(table),
            count: matched.length,
          });
          const keys = Object.entries(projection);
          return matched.map((row) => {
            const out: Row = {};
            for (const [alias, col] of keys) {
              const jsKey = this.jsKeyOf(col);
              out[alias] = row[jsKey];
            }
            return out;
          });
        };
        const builder = {
          where: (condition: SQL) => Promise.resolve(run(condition)),
          then: (
            resolve: (rows: Row[]) => unknown,
            reject?: (err: unknown) => unknown,
          ) => Promise.resolve(run()).then(resolve, reject),
        };
        return builder;
      },
    };
  }

  delete(table: PgTable) {
    return {
      where: async (condition: SQL) => {
        const matched = this.match(table, condition);
        this.remove(table, matched);
        this.ops.push({
          kind: 'delete',
          table: getTableName(table),
          count: matched.length,
        });
      },
    };
  }

  private remove(table: PgTable, victims: Row[]): void {
    if (victims.length === 0) return;
    const name = getTableName(table);
    const current = this.rows(table);
    const doomed = new Set(victims);
    this.data.set(
      name,
      current.filter((row) => !doomed.has(row)),
    );
    for (const rule of this.cascades[name] ?? []) {
      const keys = new Set(victims.map((v) => v[rule.parentKey]));
      const dependents = this.rows(rule.table);
      if (rule.action === 'cascade') {
        const removed = dependents.filter((row) => keys.has(row[rule.foreignKey]));
        this.remove(rule.table, removed);
      } else {
        for (const row of dependents) {
          if (keys.has(row[rule.foreignKey])) row[rule.foreignKey] = null;
        }
      }
    }
  }

  /**
   * Resolve a projected Drizzle column back to its JS property name. Keyed by
   * `"table"."column"`, not the bare column name — `id` exists on nearly every
   * table, so a name-only lookup would silently resolve to the wrong one.
   */
  private jsKeyOf(col: unknown): string {
    const c = col as { table?: PgTable; name?: string };
    if (typeof c?.name !== 'string' || c.table === undefined) {
      throw new Error('fake-db: projection values must be Drizzle columns');
    }
    const jsKey = this.aliases.get(`"${getTableName(c.table)}"."${c.name}"`);
    if (jsKey === undefined) {
      throw new Error(
        `fake-db: unknown column "${getTableName(c.table)}"."${c.name}" (seed its table)`,
      );
    }
    return jsKey;
  }
}

/** Cast helper — the fake implements only the narrow surface under test. */
export function asDatabase<T>(fake: FakeDb): T {
  return fake as unknown as T;
}
