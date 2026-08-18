import type {
  AnalyticsDataset,
  WorkerVersionMetadata,
} from '@crosmos/observability';
import type { DeploymentEnvironment } from '@crosmos/runtime';

export interface Env {
  HYPERDRIVE: Hyperdrive;
  API_KEY_CACHE: KVNamespace;
  ANALYTICS?: AnalyticsDataset;
  ADMIN_RATE_LIMITER: DurableObjectNamespace;
  ENVIRONMENT: DeploymentEnvironment;
  ACCESS_TEAM_DOMAIN: string;
  ACCESS_AUD: string;
  ADMIN_ALLOWED_EMAILS: string;
  ADMIN_RATE_LIMIT_PER_MINUTE?: string;
  CF_VERSION_METADATA?: WorkerVersionMetadata;
}

export type AdminEnv = {
  Bindings: Env;
  Variables: { requestId: string; actorEmail: string };
};
