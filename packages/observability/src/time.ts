export function durationMs(start: number): number {
  return Math.max(0, Math.round((performance.now() - start) * 100) / 100);
}
