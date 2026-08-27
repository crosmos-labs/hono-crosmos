export type CredentialProvider = 'notion';

export type CredentialStatus =
  | 'pending'
  | 'active'
  | 'expired'
  | 'failed'
  | 'disabled';

export interface ExternalAccountIdentity {
  externalAccountId: string;
  displayName: string | null;
}

export interface CredentialState {
  provider: CredentialProvider;
  status: CredentialStatus;
}

export interface AuthorizationStart {
  ref: string;
  authorizationUrl?: string;
}

export type CredentialCompletion =
  | (CredentialState & {
      status: 'active';
      identity: ExternalAccountIdentity;
    })
  | (CredentialState & {
      status: Exclude<CredentialStatus, 'active'>;
      identity?: never;
    });

/**
 * Credential storage and authenticated-provider access.
 *
 * Feature code works only with this canonical contract. Implementations own
 * provider-specific status mapping and credential handling.
 */
export interface CredentialBackend {
  readonly id: string;

  begin(input: {
    provider: CredentialProvider;
    userId: string;
  }): Promise<AuthorizationStart>;

  complete(ref: string): Promise<CredentialCompletion>;
  status(ref: string): Promise<CredentialState>;
  revoke(ref: string): Promise<void>;
}

/** Resolves the backend recorded in connector_connections.auth_backend. */
export interface CredentialBackends {
  get(id: string): CredentialBackend;
  forProvider(provider: CredentialProvider): CredentialBackend;
}
