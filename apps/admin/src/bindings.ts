import type { AnalyticsDataset } from '@crosmos/observability';

export interface Env {
  HYPERDRIVE: Hyperdrive;
  API_KEY_CACHE: KVNamespace;
  ANALYTICS?: AnalyticsDataset;
  ADMIN_RATE_LIMITER: DurableObjectNamespace;
  ENVIRONMENT: string;
  ACCESS_TEAM_DOMAIN: string;
  ACCESS_AUD: string;
  ADMIN_ALLOWED_EMAILS: string;
  ADMIN_RATE_LIMIT_PER_MINUTE?: string;
  CF_VERSION_METADATA?: { id: string; tag: string; timestamp: string };
}

export type AdminEnv = {
  Bindings: Env;
  Variables: { requestId: string; actorEmail: string };
};
