#!/usr/bin/env bun

type Options = {
  accountId: string;
  apiToken: string;
  from: number;
  to: number;
  limit: number;
  search?: string;
  script?: string;
};

type CloudflareEnvelope = {
  success?: boolean;
  errors?: Array<{ message?: string }>;
  events?: unknown[] | { events?: unknown[] };
  result?: {
    events?: unknown[] | { events?: unknown[] };
    [key: string]: unknown;
  } | unknown[];
};

const USAGE = `Query persisted Cloudflare Workers Logs (the last-7-days tier).

Usage:
  bun scripts/query-workers-logs.ts --request-id <uuid> [options]
  bun scripts/query-workers-logs.ts --correlation-id <uuid> [options]
  bun scripts/query-workers-logs.ts --event <event-name> [options]
  bun scripts/query-workers-logs.ts --search <text> [options]

Options:
  --since <time>     Relative duration (15m, 24h, 7d) or ISO timestamp.
                     Defaults to 24h.
  --until <time>     ISO timestamp. Defaults to now.
  --script <name>    Restrict to one Worker script name.
  --limit <n>        Maximum events, 1..2000. Defaults to 200.
  --help             Show this help.

Environment:
  CLOUDFLARE_ACCOUNT_ID
  CLOUDFLARE_API_TOKEN  Token with Workers Observability Write permission.
`;

function requiredEnv(name: string): string {
  const value = Bun.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function parseTimestamp(value: string, relativeTo: number): number {
  const duration = /^(\d+)(m|h|d)$/.exec(value);
  if (duration) {
    const amount = Number(duration[1]);
    const unitMs =
      duration[2] === 'm'
        ? 60_000
        : duration[2] === 'h'
          ? 3_600_000
          : 86_400_000;
    return relativeTo - amount * unitMs;
  }

  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    throw new Error(`Invalid time ${JSON.stringify(value)}; use ISO or 15m/24h/7d`);
  }
  return timestamp;
}

function readValue(args: string[], index: number, flag: string): string {
  const value = args[index + 1];
  if (!value || value.startsWith('--')) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

export function parseArgs(args: string[], now = Date.now()): Options | 'help' {
  if (args.includes('--help') || args.includes('-h')) return 'help';

  let since = '24h';
  let until: string | undefined;
  let script: string | undefined;
  let search: string | undefined;
  let selector: string | undefined;
  let limit = 200;

  for (let i = 0; i < args.length; i += 1) {
    const flag = args[i];
    switch (flag) {
      case '--since':
        since = readValue(args, i, flag);
        i += 1;
        break;
      case '--until':
        until = readValue(args, i, flag);
        i += 1;
        break;
      case '--script':
        script = readValue(args, i, flag);
        i += 1;
        break;
      case '--limit': {
        const raw = readValue(args, i, flag);
        limit = Number(raw);
        if (!Number.isInteger(limit) || limit < 1 || limit > 2000) {
          throw new Error('--limit must be an integer from 1 to 2000');
        }
        i += 1;
        break;
      }
      case '--request-id':
      case '--correlation-id':
      case '--event':
      case '--search': {
        if (selector) {
          throw new Error(`Use one search selector; already received ${selector}`);
        }
        selector = flag;
        search = readValue(args, i, flag);
        i += 1;
        break;
      }
      default:
        throw new Error(`Unknown argument ${JSON.stringify(flag)}`);
    }
  }

  if (!search) {
    throw new Error('One of --request-id, --correlation-id, --event, or --search is required');
  }

  const to = until ? parseTimestamp(until, now) : now;
  const from = parseTimestamp(since, to);
  if (from >= to) throw new Error('--since must be earlier than --until');

  return {
    accountId: requiredEnv('CLOUDFLARE_ACCOUNT_ID'),
    apiToken: requiredEnv('CLOUDFLARE_API_TOKEN'),
    from,
    to,
    limit,
    search,
    script,
  };
}

export function buildQuery(options: Options): Record<string, unknown> {
  return {
    queryId: 'crosmos-recent-logs',
    timeframe: { from: options.from, to: options.to },
    view: 'events',
    dry: true,
    limit: options.limit,
    parameters: {
      datasets: [],
      filterCombination: 'and',
      filters: options.script
        ? [
            {
              key: '$workers.scriptName',
              operation: 'eq',
              type: 'string',
              value: options.script,
            },
          ]
        : [],
      needle: {
        value: options.search,
        isRegex: false,
        matchCase: false,
      },
    },
  };
}

export function extractEvents(payload: CloudflareEnvelope): unknown[] {
  if (Array.isArray(payload.events)) return payload.events;
  if (payload.events && !Array.isArray(payload.events) && Array.isArray(payload.events.events)) {
    return payload.events.events;
  }
  if (Array.isArray(payload.result)) return payload.result;
  if (payload.result && !Array.isArray(payload.result)) {
    if (Array.isArray(payload.result.events)) return payload.result.events;
    if (
      payload.result.events
      && !Array.isArray(payload.result.events)
      && Array.isArray(payload.result.events.events)
    ) {
      return payload.result.events.events;
    }
  }
  throw new Error('Cloudflare query returned an unexpected response shape');
}

async function main(): Promise<void> {
  let options: Options | 'help';
  try {
    options = parseArgs(Bun.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    console.error('\n' + USAGE);
    process.exitCode = 2;
    return;
  }

  if (options === 'help') {
    console.log(USAGE);
    return;
  }

  const response = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(options.accountId)}/workers/observability/telemetry/query`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${options.apiToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(buildQuery(options)),
    },
  );
  const payload = (await response.json()) as CloudflareEnvelope;
  if (!response.ok || payload.success === false) {
    const detail = payload.errors?.map((error) => error.message).filter(Boolean).join('; ');
    throw new Error(`Cloudflare query failed (${response.status})${detail ? `: ${detail}` : ''}`);
  }

  console.log(JSON.stringify(extractEvents(payload), null, 2));
}

if (import.meta.main) {
  await main();
}
