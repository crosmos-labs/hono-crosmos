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

const WEEKDAYS: Record<string, number> = {
  sunday: 0,
  monday: 1,
  tuesday: 2,
  wednesday: 3,
  thursday: 4,
  friday: 5,
  saturday: 6,
};

function midnightUtc(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

function startOfWeekMonday(d: Date): Date {
  const day = d.getUTCDay(); // 0 = Sun, 1 = Mon
  const delta = day === 0 ? -6 : 1 - day;
  return new Date(midnightUtc(d).getTime() + delta * DAY_MS);
}

function firstOfMonth(d: Date, monthDelta: number): Date {
  const year = d.getUTCFullYear();
  const month = d.getUTCMonth() + monthDelta;
  return new Date(Date.UTC(year, month, 1));
}

function isoDate(d: Date): string {
  return midnightUtc(d).toISOString();
}

function parseFewOrInt(token: string): number {
  if (token === 'a' || token === 'an') return 1;
  if (token === 'few') return 3;
  return parseInt(token, 10);
}

/**
 * Resolve relative temporal phrases. Returns an ISO 8601 datetime string at
 * UTC midnight, or `null` if no recognized pattern matched.
 */
export function inferTemporalDate(
  content: string,
  referenceTime: Date,
): string | null {
  const text = content.toLowerCase();
  const ref = midnightUtc(referenceTime);

  // Fixed-day phrases. Ordered: most specific (multi-word) first.
  const fixed: Array<[RegExp, number]> = [
    [/\blast night\b/, -1],
    [/\byesterday\b/, -1],
    [/\btomorrow\b/, 1],
    [/\bthis morning\b/, 0],
    [/\bthis afternoon\b/, 0],
    [/\bthis evening\b/, 0],
    [/\btonight\b/, 0],
    [/\btoday\b/, 0],
  ];
  for (const [re, days] of fixed) {
    if (re.test(text)) return isoDate(new Date(ref.getTime() + days * DAY_MS));
  }

  // Numeric: "N days/weeks/months ago", "a few days ago", "in N days/weeks/months"
  const agoRe =
    /\b(a|an|few|\d+)\s+(day|days|week|weeks|month|months)\s+ago\b/;
  const agoMatch = text.match(agoRe);
  if (agoMatch) {
    const n = parseFewOrInt(agoMatch[1]!);
    const unit = agoMatch[2]!;
    const days = unit.startsWith('day') ? n : unit.startsWith('week') ? 7 * n : 30 * n;
    return isoDate(new Date(ref.getTime() - days * DAY_MS));
  }
  if (/\ba week ago\b/.test(text)) return isoDate(new Date(ref.getTime() - 7 * DAY_MS));
  if (/\ba month ago\b/.test(text)) return isoDate(new Date(ref.getTime() - 30 * DAY_MS));

  const inRe = /\bin\s+(a|an|few|\d+)\s+(day|days|week|weeks|month|months)\b/;
  const inMatch = text.match(inRe);
  if (inMatch) {
    const n = parseFewOrInt(inMatch[1]!);
    const unit = inMatch[2]!;
    const days = unit.startsWith('day') ? n : unit.startsWith('week') ? 7 * n : 30 * n;
    return isoDate(new Date(ref.getTime() + days * DAY_MS));
  }

  // Weekday: "last <weekday>", "next <weekday>"
  const weekdayRe = /\b(last|next)\s+(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/;
  const weekdayMatch = text.match(weekdayRe);
  if (weekdayMatch) {
    const direction = weekdayMatch[1]!;
    const target = WEEKDAYS[weekdayMatch[2]!]!;
    const current = ref.getUTCDay();
    let delta: number;
    if (direction === 'last') {
      delta = ((current - target - 7) % 7) || -7;
      if (delta > 0) delta -= 7;
    } else {
      delta = ((target - current + 7) % 7) || 7;
    }
    return isoDate(new Date(ref.getTime() + delta * DAY_MS));
  }

  // Week blocks
  if (/\blast week\b/.test(text))
    return isoDate(new Date(startOfWeekMonday(ref).getTime() - 7 * DAY_MS));
  if (/\bthis week\b/.test(text)) return isoDate(startOfWeekMonday(ref));
  if (/\bnext week\b/.test(text))
    return isoDate(new Date(startOfWeekMonday(ref).getTime() + 7 * DAY_MS));

  // Month blocks
  if (/\blast month\b/.test(text)) return isoDate(firstOfMonth(ref, -1));
  if (/\bthis month\b/.test(text)) return isoDate(firstOfMonth(ref, 0));
  if (/\bnext month\b/.test(text)) return isoDate(firstOfMonth(ref, 1));

  return null;
}
