/**
 * LLM provider — the interface the pipeline calls.
 *
 * Implementations: see `./openrouter.ts` and `./openai.ts`. Pick one via
 * `getLLM(env)` in `./index.ts`. The pipeline must never instantiate a
 * concrete provider directly — switching providers should be a one-file
 * change in the factory.
 *
 * Token accounting: every implementation accumulates `totalTokens` across
 * the lifetime of the instance. The worker creates one `LLM` per job and
 * sums `llm.totalTokens + embedder.totalTokens` into `daily_usage` once at
 * job completion (see worker.md §Token accumulation).
 */
export interface LLMUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface CompleteOptions {
  system: string;
  user: string;
  /** Override the provider's default model (e.g. `"openai/gpt-4.1-mini"`). */
  model?: string;
  /** 0..2; defaults to provider default (typically 1.0). */
  temperature?: number;
}

export interface CompleteJsonOptions extends CompleteOptions {
  /**
   * JSON Schema for structured output. The shape must satisfy the provider's
   * strict-mode constraints — for OpenAI/OpenRouter that means every property
   * listed in `required`, `additionalProperties: false` at every object, and
   * no top-level union/anyOf. Callers typically derive this from a Zod
   * schema via `zod-to-json-schema`.
   */
  schema: {
    name: string;
    schema: Record<string, unknown>;
  };
}

export interface LLM {
  /** The model id used when `complete*` is called without an override. */
  readonly defaultModel: string;

  /** Cumulative token count across every call made to this instance. */
  readonly totalTokens: number;

  /** Free-form text completion. */
  complete(opts: CompleteOptions): Promise<{ content: string; usage: LLMUsage }>;

  /**
   * Strict-JSON completion. The provider is told to emit JSON matching
   * `opts.schema`; the returned `data` is parsed and typed as `T`.
   * Throws if the response is not valid JSON. Schema validation is the
   * caller's responsibility (typically a Zod `.parse` on the returned data).
   */
  completeJson<T = unknown>(
    opts: CompleteJsonOptions,
  ): Promise<{ data: T; usage: LLMUsage }>;
}
