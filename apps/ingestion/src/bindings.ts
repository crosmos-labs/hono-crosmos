export interface Env {
  // Bindings
  HYPERDRIVE: Hyperdrive;

  // Vars
  ENVIRONMENT: 'development' | 'production';
  LLM_PROVIDER: 'openrouter' | 'openai';

  // Secrets (set via `wrangler secret put` or .dev.vars)
  OPENROUTER_API_KEY?: string;
  OPENAI_API_KEY?: string;
  ZEROENTROPY_API_KEY?: string;
  SENTRY_DSN?: string;
}
