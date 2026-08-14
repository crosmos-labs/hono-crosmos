type JsonRecord = Record<string, unknown>;

export type RetrievalTiming = {
  requestId: string;
  tookMs: number;
};

export type PrivateTimingQuery = {
  accountId: string;
  apiToken: string;
  requestIds: string[];
  from: number;
  to: number;
  scriptName?: string;
};

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

type CloudflareEnvelope = {
  success?: boolean;
  errors?: Array<{ message?: string }>;
  result?: { events?: unknown[] };
};

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function parseJson(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

/**
 * Workers Observability may return a console object directly as `source`, or
 * wrap/stringify it in a message field. Walk only the small set of envelope
 * fields Cloudflare documents; do not recursively inspect arbitrary payloads.
 */
function candidateRecords(event: unknown): JsonRecord[] {
  if (!isRecord(event)) return [];
  const values = [
    event,
    parseJson(event.source),
    isRecord(event.source) ? parseJson(event.source.message) : undefined,
    isRecord(event.$metadata) ? parseJson(event.$metadata.message) : undefined,
  ];
  return values.filter(isRecord);
}

export function extractRetrievalTimings(
  events: unknown[],
  expectedRequestIds: Iterable<string>,
): Map<string, number> {
  const expected = new Set(expectedRequestIds);
  const timings = new Map<string, number>();
  for (const event of events) {
    for (const record of candidateRecords(event)) {
      if (record.event !== 'retrieval.request_completed') continue;
      const requestId = record.request_id;
      const tookMs = record.duration_ms;
      if (
        typeof requestId !== 'string'
        || !expected.has(requestId)
        || typeof tookMs !== 'number'
        || !Number.isFinite(tookMs)
        || tookMs < 0
      ) {
        continue;
      }
      timings.set(requestId, tookMs);
    }
  }
  return timings;
}

export function buildPrivateTimingQuery(
  options: Pick<PrivateTimingQuery, 'from' | 'to' | 'scriptName' | 'requestIds'>,
): Record<string, unknown> {
  if (options.requestIds.length === 0) {
    throw new Error('Private timing query requires at least one request id');
  }
  return {
    queryId: 'crosmos-private-retrieval-timing',
    timeframe: { from: options.from, to: options.to },
    view: 'events',
    dry: true,
    limit: Math.min(2000, Math.max(100, options.requestIds.length * 2)),
    parameters: {
      datasets: [],
      filterCombination: 'and',
      filters: options.scriptName
        ? [{
            key: '$workers.scriptName',
            operation: 'eq',
            type: 'string',
            value: options.scriptName,
          }]
        : [],
      needle: {
        value: options.requestIds.map(escapeRegex).join('|'),
        isRegex: true,
        matchCase: true,
      },
    },
  };
}

export async function fetchPrivateRetrievalTimings(
  options: PrivateTimingQuery,
  fetchImpl: typeof fetch = fetch,
): Promise<Map<string, number>> {
  if (options.requestIds.length === 0) return new Map();
  if (options.requestIds.length > 100) {
    throw new Error('Private timing lookup supports at most 100 benchmark requests');
  }
  const response = await fetchImpl(
    `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(options.accountId)}/workers/observability/telemetry/query`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${options.apiToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(buildPrivateTimingQuery(options)),
    },
  );
  const payload = (await response.json()) as CloudflareEnvelope;
  if (!response.ok || payload.success === false) {
    const detail = payload.errors?.map((error) => error.message).filter(Boolean).join('; ');
    throw new Error(
      `Cloudflare private timing query failed (${response.status})${detail ? `: ${detail}` : ''}`,
    );
  }
  return extractRetrievalTimings(payload.result?.events ?? [], options.requestIds);
}

export async function waitForPrivateRetrievalTimings(
  options: PrivateTimingQuery & {
    timeoutMs?: number;
    pollMs?: number;
    now?: () => number;
    sleep?: (ms: number) => Promise<void>;
    fetchImpl?: typeof fetch;
  },
): Promise<Map<string, number>> {
  const timeoutMs = options.timeoutMs ?? 5 * 60_000;
  const pollMs = options.pollMs ?? 10_000;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  const deadline = now() + timeoutMs;
  let timings = new Map<string, number>();
  do {
    timings = await fetchPrivateRetrievalTimings(
      { ...options, to: now() + 5_000 },
      options.fetchImpl,
    );
    if (timings.size === options.requestIds.length) return timings;
    if (now() >= deadline) break;
    await sleep(Math.min(pollMs, Math.max(0, deadline - now())));
  } while (now() <= deadline);

  const missing = options.requestIds.filter((requestId) => !timings.has(requestId));
  throw new Error(
    `Private retrieval telemetry did not arrive before timeout; missing ${missing.length}/${options.requestIds.length} request ids`,
  );
}
