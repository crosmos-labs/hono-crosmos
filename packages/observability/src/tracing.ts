/** Structural subset of Cloudflare's custom-spans API used by the workers. */
export interface TraceSpan {
  setAttribute(key: string, value?: boolean | number | string): void;
}

export interface TraceProvider {
  enterSpan<T>(name: string, callback: (span: TraceSpan) => T): T;
}
