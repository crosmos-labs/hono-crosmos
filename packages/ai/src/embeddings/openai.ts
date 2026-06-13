import { OpenAICompatEmbedder } from './openai-compat';

// Re-exported so existing importers (`./openai`) keep working after the error
// type moved to the shared base. New code can import it from `./openai-compat`.
export { EmbeddingRequestError } from './openai-compat';

/**
 * OpenAI `text-embedding-3-small`. The model is natively 1536-dim but supports
 * Matryoshka dimension reduction via the `dimensions` request param, so we pin
 * it to the deployment's vector space (default 1024 — the Vectorize index
 * dimension) instead of re-creating the index. Requires `OPENAI_API_KEY`.
 *
 * `text-embedding-3-small` is symmetric: document and search modes share one
 * vector space, so the `mode` option is informational here.
 */
const DEFAULT_MODEL = 'text-embedding-3-small';
const DEFAULT_DIMENSIONS = 1024;
const BASE_URL = 'https://api.openai.com/v1';

export interface OpenAIEmbedderConfig {
  apiKey: string;
  /** Output dimensionality. Default 1024 (the Vectorize index dimension). */
  dimensions?: number;
  /** Override the default model id. */
  model?: string;
}

export class OpenAIEmbedder extends OpenAICompatEmbedder {
  constructor(config: OpenAIEmbedderConfig) {
    super({
      baseUrl: BASE_URL,
      apiKey: config.apiKey,
      model: config.model ?? DEFAULT_MODEL,
      dimensions: config.dimensions ?? DEFAULT_DIMENSIONS,
      providerLabel: 'OpenAI',
    });
  }
}
