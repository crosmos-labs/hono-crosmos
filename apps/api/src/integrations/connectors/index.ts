import type { Env } from '../../bindings';
import {
  ComposioBackend,
  createComposioClient,
} from './composio';
import type { CredentialBackend, CredentialBackends } from './port';

export type {
  AuthorizationStart,
  CredentialBackend,
  CredentialBackends,
  CredentialCompletion,
  CredentialProvider,
  CredentialState,
  CredentialStatus,
  ExternalAccountIdentity,
} from './port';

export function getCredentialBackends(env: Env): CredentialBackends {
  let composio: CredentialBackend | undefined;

  const get = (id: string): CredentialBackend => {
    if (id !== 'composio') {
      throw new Error(`Unsupported credential backend: ${id}`);
    }

    if (composio) return composio;
    if (!env.COMPOSIO_API_KEY) throw new Error('COMPOSIO_API_KEY is required');

    composio = new ComposioBackend(createComposioClient(env.COMPOSIO_API_KEY), {
      callbackUrl: env.CONNECTOR_CALLBACK_URL,
      notionAuthConfigId: env.COMPOSIO_NOTION_AUTH_CONFIG_ID,
    });
    return composio;
  };

  return {
    get,
    forProvider(provider) {
      switch (provider) {
        case 'notion':
          if (
            !env.COMPOSIO_NOTION_AUTH_CONFIG_ID ||
            !env.CONNECTOR_CALLBACK_URL
          ) {
            throw new Error('Notion connector is not configured');
          }
          return get('composio');
      }
    },
  };
}
