import type { AnalyticsDataset, Metrics } from './types';

const NOOP_METRICS: Metrics = { count() {} };

export function createMetrics(
  dataset: AnalyticsDataset | undefined,
  base?: { service?: string; environment?: string; version?: string },
): Metrics {
  if (!dataset) return NOOP_METRICS;
  const service = base?.service ?? 'unknown';
  const environment = base?.environment ?? 'development';
  const version = base?.version?.slice(0, 8) || 'unknown';
  return {
    count(name, fields = {}) {
      try {
        const tagBlobs = (fields.tags ?? []).map((tag) =>
          tag == null ? null : String(tag),
        );
        dataset.writeDataPoint({
          indexes: [fields.index ?? name],
          blobs: [service, environment, name, version, ...tagBlobs].slice(0, 20),
          doubles: (fields.values ?? []).slice(0, 20),
        });
      } catch {
        // Telemetry is best-effort and must never break application work.
      }
    },
  };
}
