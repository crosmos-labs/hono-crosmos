export function readServerTookMs(
  headers: Pick<Headers, 'get'>,
): number {
  const raw = headers.get('x-crosmos-took-ms');
  if (raw == null || raw.trim() === '') {
    throw new Error('Search response is missing X-Crosmos-Took-Ms');
  }
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`Invalid X-Crosmos-Took-Ms value: ${JSON.stringify(raw)}`);
  }
  return value;
}
