/**
 * Deterministic temporal regex fallback. Mirrors
 * `app/engine/extractors/temporal.py`.
 *
 * Runs after Pass 1 for any extracted memory whose `event_time` is null. The
 * LLM is supposed to resolve relative dates against `reference_time`, but it
 * sometimes leaves the field empty when the phrase was non-obvious. The
 * regex fallback catches the easy cases ("yesterday", "next monday",
 * "2 weeks ago") so we don't lose temporal context.
 *
 * Patterns and arithmetic match pipeline.md §Stage 4. All resolved dates
 * are clamped to 00:00:00 UTC.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/** Python weekday(): Monday=0, ..., Sunday=6. */
const WEEKDAY_MAP: Record<string, number> = {
  monday: 0,
  tuesday: 1,
  wednesday: 2,
  thursday: 3,
  friday: 4,
  saturday: 5,
  sunday: 6,
};

function pyWeekday(d: Date): number {
  // getUTCDay: Sun=0..Sat=6; convert to Python weekday (Mon=0..Sun=6).
  return (d.getUTCDay() + 6) % 7;
}

function toMidnightUtc(d: Date): Date {
  return new Date(
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 0, 0, 0, 0),
  );
}

function addDays(d: Date, days: number): Date {
  return new Date(d.getTime() + days * DAY_MS);
}

/**
 * Mirror Python's `datetime.isoformat()` for a midnight-aware datetime.
 * Python emits `2026-05-18T00:00:00+00:00` (with offset) when tz-aware, or
 * `2026-05-18T00:00:00` when naive. Reference times from the pipeline are
 * always tz-aware (UTC), so we emit the offset form.
 */
function dateIso(d: Date): string {
  const mid = toMidnightUtc(d);
  const y = mid.getUTCFullYear().toString().padStart(4, '0');
  const m = (mid.getUTCMonth() + 1).toString().padStart(2, '0');
  const day = mid.getUTCDate().toString().padStart(2, '0');
  return `${y}-${m}-${day}T00:00:00+00:00`;
}

/**
 * Deterministic regex-based temporal inference. Mirrors
 * `app/engine/extractors/temporal.py:infer_temporal_date`.
 *
 * Runs after Pass 1 for any extracted memory whose `event_time` is null. The
 * LLM is supposed to resolve relative dates against `reference_time`, but it
 * sometimes leaves the field empty when the phrase was non-obvious. The
 * regex fallback catches the easy cases ("yesterday", "next monday",
 * "2 weeks ago") so we don't lose temporal context.
 */
export function inferTemporalDate(
  content: string,
  referenceTime: Date | null,
): string | null {
  if (referenceTime === null) return null;
  const textLower = content.toLowerCase();

  const fixedPatterns: Array<[RegExp, number]> = [
    [/\blast night\b/, -1],
    [/\byesterday\b/, -1],
    [/\btoday\b/, 0],
    [/\bthis morning\b/, 0],
    [/\bthis afternoon\b/, 0],
    [/\bthis evening\b/, 0],
    [/\btonight\b/, 0],
    [/\btomorrow\b/, 1],
  ];
  for (const [pattern, offset] of fixedPatterns) {
    if (pattern.test(textLower)) {
      return dateIso(addDays(referenceTime, offset));
    }
  }

  const numericPatterns: Array<[RegExp, number]> = [
    [/\b(\d+)\s*days?\s+ago\b/, -1],
    [/\ba\s+few\s+days?\s+ago\b/, -3],
    [/\b(\d+)\s*weeks?\s+ago\b/, -7],
    [/\ba\s+week\s+ago\b/, -7],
    [/\b(\d+)\s*months?\s+ago\b/, -30],
    [/\ba\s+month\s+ago\b/, -30],
    [/\bin\s+(\d+)\s*days?\b/, 1],
    [/\bin\s+(\d+)\s*weeks?\b/, 7],
    [/\bin\s+(\d+)\s*months?\b/, 30],
  ];
  for (const [pattern, unitDays] of numericPatterns) {
    const match = textLower.match(pattern);
    if (match) {
      const num = match[1] !== undefined ? parseInt(match[1], 10) : 1;
      return dateIso(addDays(referenceTime, num * unitDays));
    }
  }

  const weekdayMatch = textLower.match(
    /\b(last|next)\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/,
  );
  if (weekdayMatch) {
    const direction = weekdayMatch[1]!;
    const dayName = weekdayMatch[2]!;
    const targetDow = WEEKDAY_MAP[dayName]!;
    const currentDow = pyWeekday(referenceTime);
    // Emulate Python's modulo (always non-negative) and `x or N` fallback.
    let delta: number;
    if (direction === 'last') {
      const mod = (((currentDow - targetDow - 7) % 7) + 7) % 7;
      delta = mod === 0 ? -7 : mod;
    } else {
      const mod = (((targetDow - currentDow + 7) % 7) + 7) % 7;
      delta = mod === 0 ? 7 : mod;
    }
    return dateIso(addDays(referenceTime, delta));
  }

  if (/\blast week\b/.test(textLower)) {
    const monday = addDays(referenceTime, -(pyWeekday(referenceTime) + 7));
    return dateIso(monday);
  }
  if (/\bthis week\b/.test(textLower)) {
    const monday = addDays(referenceTime, -pyWeekday(referenceTime));
    return dateIso(monday);
  }
  if (/\bnext week\b/.test(textLower)) {
    const monday = addDays(referenceTime, 7 - pyWeekday(referenceTime));
    return dateIso(monday);
  }

  if (/\blast month\b/.test(textLower)) {
    const firstOfThis = new Date(
      Date.UTC(referenceTime.getUTCFullYear(), referenceTime.getUTCMonth(), 1),
    );
    const lastMonth = addDays(firstOfThis, -1);
    const firstOfLast = new Date(
      Date.UTC(lastMonth.getUTCFullYear(), lastMonth.getUTCMonth(), 1),
    );
    return dateIso(firstOfLast);
  }
  if (/\bthis month\b/.test(textLower)) {
    return dateIso(
      new Date(Date.UTC(referenceTime.getUTCFullYear(), referenceTime.getUTCMonth(), 1)),
    );
  }
  if (/\bnext month\b/.test(textLower)) {
    // Python: (reference_time.replace(day=28) + timedelta(days=4)).replace(day=1)
    const day28 = new Date(
      Date.UTC(referenceTime.getUTCFullYear(), referenceTime.getUTCMonth(), 28),
    );
    const plus4 = addDays(day28, 4);
    return dateIso(
      new Date(Date.UTC(plus4.getUTCFullYear(), plus4.getUTCMonth(), 1)),
    );
  }

  return null;
}
