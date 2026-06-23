/**
 * Temporal signal — verbatim port of `app/engine/retrieval/temporal.py`.
 *
 * Every regex and the ladder order below ARE the contract. All datetime math
 * is in UTC. Two JS-specific adaptations (documented in
 * signals-temporal.md §"Date arithmetic caveats"):
 *   - JS has milliseconds, not microseconds: `_day_end` uses .999 not .999999.
 *     Only matters for events timestamped in the last ms of a day.
 *   - Python weekday() is Mon=0..Sun=6; JS getUTCDay() is Sun=0..Sat=6. We
 *     convert via `pyWeekday`.
 *
 * The `dateparser` fallback (step 17) returns null in v1 — matching Python
 * when the lib is unavailable (`_dateparser_search is None`). See decisions.md §6.
 */
import { type Database, memories } from '@crosmos/db';
import type { TenantScope } from '@crosmos/types';
import { and, desc, isNull, sql } from 'drizzle-orm';
import { scopeMemories } from '../../lib/scope';
import { retrievalMemoryColumns } from './candidates';
import { TEMPORAL_CANDIDATE_LIMIT } from './constants';
import { toRankedCandidate } from './mapping';
import { type RankedCandidate, SourceSignal } from './types';

export type TemporalRange = [Date, Date];

const MONTH_ALT =
  'january|february|march|april|may|june|july|august|september|october|november|december';

const MONTH_NAMES: Record<string, number> = {
  january: 1,
  february: 2,
  march: 3,
  april: 4,
  may: 5,
  june: 6,
  july: 7,
  august: 8,
  september: 9,
  october: 10,
  november: 11,
  december: 12,
};

const UNIT_TO_DAYS: Record<string, number> = {
  day: 1,
  week: 7,
  month: 30,
  year: 365,
};

// Insertion order matters (Monday → Sunday), so use an array of pairs.
const DAYS_OF_WEEK: Array<[string, number]> = [
  ['monday', 0],
  ['tuesday', 1],
  ['wednesday', 2],
  ['thursday', 3],
  ['friday', 4],
  ['saturday', 5],
  ['sunday', 6],
];

const FUZZY_DAYS: Record<string, number> = {
  recently: 14,
  lately: 14,
  'just now': 1,
  'the other day': 5,
  'not too long ago': 30,
  'not long ago': 30,
  'a while ago': 90,
  'a few days ago': 7,
};

const NON_TEMPORAL_OVERRIDE_PATTERNS: RegExp[] = [
  /\bcurrent version\b/,
  /\bcurrent code\b/,
  /\bcurrent directory\b/,
  /\bcurrent working\b/,
  /\bcurrent (file|project|repo|repository|branch|folder|path)\b/,
  /\bhow (to|do|can|does|should)\b(?!.+\b(i|me|my|mine|myself|we|us|our|ours|user)\b)/,
  /\bexplain\b(?!.+\b(i|me|my|mine|myself|we|us|our|ours|user)\b)/,
  /\bdefine\b(?!.+\b(i|me|my|mine|myself|we|us|our|ours|user)\b)/,
];

const MONTH_YEAR_RE = new RegExp(`\\b(${MONTH_ALT})\\s+(20\\d{2})\\b`, 'i');
const AGO_RE = /(\d+|a)\s+(day|week|month|year)s?\s+ago/i;
const DURATION_RE =
  /(?:for|over|within|in|during)\s+the\s+(?:last|past)\s+(\d+)\s+(day|week|month|year)s?/i;
const THIS_PERIOD_RE = /\bthis\s+(week|month|year|quarter)\b/i;
const FUZZY_RE =
  /\b(recently|lately|just now|the other day|not too long ago|not long ago|a while ago|a few days ago|a couple of (?:days|weeks|months) ago)\b/i;
const SINCE_DATE_RE = new RegExp(`\\bsince\\s+((?:${MONTH_ALT})\\s+(?:20\\d{2}))\\b`, 'i');
const BETWEEN_RANGE_RE = new RegExp(
  '\\bbetween\\s+' +
    `((?:${MONTH_ALT})(?:\\s+\\d{1,2})?(?:\\s*,?\\s*20\\d{2})?)` +
    '\\s+(?:and|to|-)\\s+' +
    `((?:${MONTH_ALT})(?:\\s+\\d{1,2})?(?:\\s*,?\\s*20\\d{2})?)\\b`,
  'i',
);
const LOOSE_MONTH_DAY_YEAR_RE = new RegExp(
  `^(${MONTH_ALT})(?:\\s+(\\d{1,2}))?(?:\\s*,?\\s*(20\\d{2}))?$`,
  'i',
);

// ── datetime helpers (all UTC) ────────────────────────────────────────────

function dayStart(d: Date): Date {
  return new Date(
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 0, 0, 0, 0),
  );
}

function dayEnd(d: Date): Date {
  return new Date(
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 23, 59, 59, 999),
  );
}

function addDays(d: Date, days: number): Date {
  return new Date(d.getTime() + days * 86_400_000);
}

/** Python's Monday=0..Sunday=6 weekday from a UTC Date (JS is Sunday=0). */
function pyWeekday(d: Date): number {
  return (d.getUTCDay() + 6) % 7;
}

function endOfMonthLastMs(year: number, month1: number): Date {
  // Last millisecond of month `month1` (1-based). first-of-next-month − 1ms.
  if (month1 === 12) {
    return new Date(Date.UTC(year, 11, 31, 23, 59, 59, 999));
  }
  return new Date(Date.UTC(year, month1, 1) - 1);
}

function collapseLower(query: string): string {
  return query.trim().split(/\s+/).join(' ').toLowerCase();
}

// ── public API ──────────────────────────────────────────────────────────

export function extractTemporalRange(
  query: string,
  now: Date = new Date(),
): TemporalRange | null {
  const lowered = collapseLower(query);
  if (!lowered) return null;

  for (const pattern of NON_TEMPORAL_OVERRIDE_PATTERNS) {
    if (pattern.test(lowered)) return null;
  }

  return extractPeriod(lowered, now);
}

function parseMonthYear(text: string): Date | null {
  const m = MONTH_YEAR_RE.exec(text.toLowerCase());
  if (!m) return null;
  const month = MONTH_NAMES[m[1]!.toLowerCase()]!;
  const year = parseInt(m[2]!, 10);
  return new Date(Date.UTC(year, month - 1, 1));
}

function parseLooseMonthDate(text: string, now: Date): Date | null {
  const parsed = parseMonthYear(text);
  if (parsed) return parsed;
  const m = LOOSE_MONTH_DAY_YEAR_RE.exec(text.trim());
  if (m) {
    const month = MONTH_NAMES[m[1]!.toLowerCase()]!;
    const day = m[2] ? parseInt(m[2], 10) : 1;
    const year = m[3] ? parseInt(m[3], 10) : now.getUTCFullYear();
    return new Date(Date.UTC(year, month - 1, day));
  }
  return null;
}

function extractPeriod(lowered: string, now: Date): TemporalRange | null {
  // 1. "between [month] and [month]"
  const between = BETWEEN_RANGE_RE.exec(lowered);
  if (between) {
    const startDt = parseLooseMonthDate(between[1]!, now);
    const endDt = parseLooseMonthDate(between[2]!, now);
    if (startDt && endDt) return [dayStart(startDt), dayEnd(endDt)];
  }

  // 2. "since [month year]"
  const since = SINCE_DATE_RE.exec(lowered);
  if (since) {
    const parsed = parseMonthYear(since[1]!);
    if (parsed) return [dayStart(parsed), dayEnd(now)];
  }

  // 3. month + year
  const monthYear = MONTH_YEAR_RE.exec(lowered);
  if (monthYear) {
    const month = MONTH_NAMES[monthYear[1]!.toLowerCase()]!;
    const year = parseInt(monthYear[2]!, 10);
    const start = new Date(Date.UTC(year, month - 1, 1));
    const end = endOfMonthLastMs(year, month);
    return [dayStart(start), end];
  }

  // 4. single unit ago
  const ago = AGO_RE.exec(lowered);
  if (ago) {
    const amount = ago[1] === 'a' ? 1 : parseInt(ago[1]!, 10);
    const days = amount * UNIT_TO_DAYS[ago[2]!]!;
    const target = addDays(now, -days);
    return [dayStart(target), dayEnd(target)];
  }

  // 5. rolling window to now
  const duration = DURATION_RE.exec(lowered);
  if (duration) {
    const days = parseInt(duration[1]!, 10) * UNIT_TO_DAYS[duration[2]!]!;
    return [dayStart(addDays(now, -days)), dayEnd(now)];
  }

  // 6. this week / month / year / quarter
  const thisPeriod = THIS_PERIOD_RE.exec(lowered);
  if (thisPeriod) {
    const unit = thisPeriod[1]!;
    let start: Date;
    if (unit === 'week') {
      start = dayStart(addDays(now, -pyWeekday(now)));
    } else if (unit === 'month') {
      start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    } else if (unit === 'quarter') {
      const qm0 = Math.floor(now.getUTCMonth() / 3) * 3; // 0-based first month of quarter
      start = new Date(Date.UTC(now.getUTCFullYear(), qm0, 1));
    } else {
      // year
      start = new Date(Date.UTC(now.getUTCFullYear(), 0, 1));
    }
    return [start, dayEnd(now)];
  }

  // 7. fuzzy expressions
  const fuzzy = FUZZY_RE.exec(lowered);
  if (fuzzy) {
    const text = fuzzy[0]!.toLowerCase();
    let days = FUZZY_DAYS[text];
    if (days === undefined) {
      // "a couple of X ago"
      days = text.includes('week') ? 14 : text.includes('month') ? 60 : 3;
    }
    return [dayStart(addDays(now, -days)), dayEnd(now)];
  }

  // 8. "last week"
  if (lowered.includes('last week')) {
    const start = dayStart(addDays(now, -(pyWeekday(now) + 7)));
    return [start, dayEnd(addDays(start, 6))];
  }

  // 9. "last month"
  if (lowered.includes('last month')) {
    const first = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    const end = addDays(first, -1);
    const startOfEndMonth = new Date(
      Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), 1),
    );
    return [dayStart(startOfEndMonth), dayEnd(end)];
  }

  // 10. "last year"
  if (lowered.includes('last year')) {
    const y = now.getUTCFullYear() - 1;
    return [
      new Date(Date.UTC(y, 0, 1)),
      new Date(Date.UTC(y, 11, 31, 23, 59, 59, 999)),
    ];
  }

  // 11. "last quarter"
  if (lowered.includes('last quarter')) {
    const cq = Math.floor((now.getUTCMonth() + 1 - 1) / 3); // (month-1)//3, month 1-based
    if (cq === 0) {
      return [
        new Date(Date.UTC(now.getUTCFullYear() - 1, 9, 1)),
        new Date(Date.UTC(now.getUTCFullYear() - 1, 11, 31, 23, 59, 59, 999)),
      ];
    }
    const qm = (cq - 1) * 3 + 1; // 1-based month
    const start = new Date(Date.UTC(now.getUTCFullYear(), qm - 1, 1));
    // Python: datetime(year, qm+2, 1) − 1µs → last ms of month (qm+1).
    const end = new Date(Date.UTC(now.getUTCFullYear(), qm + 1, 1) - 1);
    return [start, end];
  }

  // 12. yesterday
  if (lowered.includes('yesterday')) {
    const d = addDays(now, -1);
    return [dayStart(d), dayEnd(d)];
  }

  // 13. today
  if (lowered.includes('today')) {
    return [dayStart(now), dayEnd(now)];
  }

  // 14. "last <weekday>"
  for (const [dayName, weekday] of DAYS_OF_WEEK) {
    if (new RegExp(`\\blast\\s+${dayName}\\b`).test(lowered)) {
      const daysBack = (((pyWeekday(now) - weekday) % 7) + 7) % 7 || 7;
      const d = addDays(now, -daysBack);
      return [dayStart(d), dayEnd(d)];
    }
  }

  // 15. "on <weekday>", "this <weekday>"
  for (const [dayName, weekday] of DAYS_OF_WEEK) {
    if (new RegExp(`\\b(?:on|this)\\s+${dayName}\\b`).test(lowered)) {
      const wd = pyWeekday(now);
      const d = wd >= weekday ? addDays(now, -(wd - weekday)) : addDays(now, -(wd + 7 - weekday));
      return [dayStart(d), dayEnd(d)];
    }
  }

  // 16. years only
  const years = lowered.match(/\b(?:19|20|21)\d{2}\b/g);
  if (years && years.length > 0) {
    const y = parseInt(years[0]!, 10);
    return [
      new Date(Date.UTC(y, 0, 1)),
      new Date(Date.UTC(y, 11, 31, 23, 59, 59, 999)),
    ];
  }

  // 17. dateparser fallback — v1 returns null (decisions.md §6).
  return null;
}

/**
 * Temporal proximity score in [0, 1]. In-range points score [0.5, 1.0] with
 * center-biased proximity; out-of-range → 0.0.
 */
export function temporalProximityScore(
  reference: Date | null,
  start: Date,
  end: Date,
): number {
  if (reference === null) return 0.0;
  if (reference < start || reference > end) return 0.0;

  const windowSeconds = Math.max((end.getTime() - start.getTime()) / 1000, 1.0);
  const halfWindow = windowSeconds / 2.0;
  const center = new Date(start.getTime() + halfWindow * 1000);
  const distance = Math.abs((reference.getTime() - center.getTime()) / 1000);
  const base = Math.max(0.0, Math.min(1.0, 1.0 - distance / halfWindow));
  return 0.5 + 0.5 * base;
}

/**
 * Temporal signal — selects in-window memories ordered by proximity to the
 * window centre (bounded SQL range query + LIMIT), then scores them in JS.
 */
export async function temporalSearch(
  db: Database,
  scope: TenantScope,
  start: Date,
  end: Date,
  limit: number = TEMPORAL_CANDIDATE_LIMIT,
): Promise<RankedCandidate[]> {
  const center = new Date(start.getTime() + (end.getTime() - start.getTime()) / 2);
  const halfWindowSeconds = Math.max(
    (end.getTime() - start.getTime()) / 1000 / 2.0,
    1.0,
  );

  // Reference instant per memory: event_time, else recorded_at, else created_at.
  // recorded_at/created_at are NOT NULL, so the coalesce never yields null —
  // matching the old `?? ` chain (whose null-guard was therefore dead). The
  // range filter + proximity ordering + LIMIT are pushed into Postgres so the
  // signal no longer scans the whole in-memory working set. Proximity-asc
  // ordering is identical to the old score-desc sort (score is monotone in
  // distance); ties are broken by id desc for determinism (the old order
  // depended on row load order). Score is computed in JS, same formula.
  //
  // Bounds are passed as ISO strings + an explicit `::timestamptz` cast, NOT raw
  // Date objects: a `Date` interpolated into a raw `sql` template is handed to
  // the driver untyped, which the postgres.js driver rejects ("must be string").
  // (Typed-column comparators serialize Dates for you; raw `sql` does not.)
  const ref = sql`coalesce(${memories.eventTime}, ${memories.recordedAt}, ${memories.createdAt})`;
  const rows = await db
    .select(retrievalMemoryColumns)
    .from(memories)
    .where(
      and(
        scopeMemories(scope),
        isNull(memories.forgottenAt),
        sql`${ref} >= ${start.toISOString()}::timestamptz`,
        sql`${ref} <= ${end.toISOString()}::timestamptz`,
      ),
    )
    .orderBy(
      sql`abs(extract(epoch from (${ref} - ${center.toISOString()}::timestamptz)))`,
      desc(memories.id),
    )
    .limit(limit);

  return rows.map((memory, i) => {
    const refInstant = memory.eventTime ?? memory.recordedAt ?? memory.createdAt;
    const distance = Math.abs((refInstant.getTime() - center.getTime()) / 1000);
    const base = Math.max(1.0 - distance / halfWindowSeconds, 0.0);
    const score = 0.5 + 0.5 * base;
    return toRankedCandidate(memory, i + 1, score, SourceSignal.TEMPORAL);
  });
}
