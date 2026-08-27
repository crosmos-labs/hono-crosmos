import {
  Composio,
  type ConnectedAccountRetrieveResponse,
  type ConnectedAccountStatus,
  type CreateConnectedAccountLinkOptions,
} from '@composio/core';
import type {
  CredentialBackend,
  CredentialCompletion,
  CredentialProvider,
  CredentialState,
  CredentialStatus,
  ExternalAccountIdentity,
} from './port';

const NOTION_API_VERSION = '2026-03-11';

export interface ComposioClient {
  connectedAccounts: {
    link(
      userId: string,
      authConfigId: string,
      options?: CreateConnectedAccountLinkOptions,
    ): Promise<{ id: string; redirectUrl?: string | null }>;
    get(id: string): Promise<ConnectedAccountRetrieveResponse>;
    delete(id: string): Promise<unknown>;
  };
  tools: {
    proxyExecute(input: {
      endpoint: string;
      method: 'GET';
      connectedAccountId: string;
      parameters: Array<{
        in: 'header';
        name: string;
        value: string;
      }>;
    }): Promise<{ status: number; data?: unknown }>;
  };
}

export function createComposioClient(apiKey: string): Composio {
  if (apiKey.trim().length === 0) {
    throw new Error('COMPOSIO_API_KEY is required');
  }

  return new Composio({
    apiKey,
    allowTracking: false,
  });
}

export class ComposioBackend implements CredentialBackend {
  readonly id = 'composio';

  constructor(
    private readonly composio: ComposioClient,
    private readonly config: {
      callbackUrl?: string;
      notionAuthConfigId?: string;
    },
  ) {}

  async begin(input: { provider: CredentialProvider; userId: string }) {
    if (!this.config.callbackUrl) {
      throw new Error('CONNECTOR_CALLBACK_URL is required');
    }
    const authorization = await this.composio.connectedAccounts.link(
      input.userId,
      this.authConfigId(input.provider),
      {
        callbackUrl: this.config.callbackUrl,
        allowMultiple: true,
      },
    );

    return {
      ref: authorization.id,
      authorizationUrl: authorization.redirectUrl ?? undefined,
    };
  }

  async complete(ref: string): Promise<CredentialCompletion> {
    const state = await this.status(ref);
    if (state.status !== 'active') {
      return { provider: state.provider, status: state.status };
    }

    return {
      ...state,
      status: 'active' as const,
      identity: await fetchNotionWorkspaceIdentity(this.composio, ref),
    };
  }

  async status(ref: string): Promise<CredentialState> {
    const account = await this.composio.connectedAccounts.get(ref);
    return {
      provider: parseProvider(account.toolkit.slug),
      status: mapComposioStatus(account.status, account.isDisabled),
    };
  }

  async revoke(ref: string): Promise<void> {
    await this.composio.connectedAccounts.delete(ref);
  }

  private authConfigId(provider: CredentialProvider): string {
    switch (provider) {
      case 'notion': {
        if (!this.config.notionAuthConfigId) {
          throw new Error('COMPOSIO_NOTION_AUTH_CONFIG_ID is required');
        }
        return this.config.notionAuthConfigId;
      }
    }
  }
}

async function fetchNotionWorkspaceIdentity(
  composio: ComposioClient,
  authConnectionId: string,
): Promise<ExternalAccountIdentity> {
  const response = await composio.tools.proxyExecute({
    endpoint: '/v1/users/me',
    method: 'GET',
    connectedAccountId: authConnectionId,
    parameters: [
      {
        in: 'header',
        name: 'Notion-Version',
        value: NOTION_API_VERSION,
      },
    ],
  });

  if (response.status < 200 || response.status >= 300) {
    throw new Error(`Notion identity request failed with ${response.status}`);
  }

  const data = asRecord(response.data);
  const bot = asRecord(data?.bot);
  const externalAccountId = nonEmptyString(bot?.workspace_id);
  if (!externalAccountId) {
    throw new Error('Notion identity response did not include workspace_id');
  }

  return {
    externalAccountId,
    displayName: nonEmptyString(bot?.workspace_name),
  };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

export function mapComposioStatus(
  status: ConnectedAccountStatus,
  disabled = false,
): CredentialStatus {
  if (disabled || status === 'INACTIVE' || status === 'REVOKED') {
    return 'disabled';
  }

  switch (status) {
    case 'ACTIVE':
      return 'active';
    case 'FAILED':
      return 'failed';
    case 'EXPIRED':
      return 'expired';
    case 'INITIALIZING':
    case 'INITIATED':
      return 'pending';
  }
}

function parseProvider(slug: string): CredentialProvider {
  if (slug === 'notion') return slug;
  throw new Error(`Unsupported connector provider: ${slug}`);
}
