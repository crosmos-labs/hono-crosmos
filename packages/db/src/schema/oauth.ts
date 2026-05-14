import { sql } from 'drizzle-orm';
import {
  boolean,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  varchar,
} from 'drizzle-orm/pg-core';
import { users } from './users';

export const oauthClients = pgTable(
  'oauth_clients',
  {
    clientId: varchar('client_id', { length: 255 }).primaryKey(),
    clientSecretHash: varchar('client_secret_hash', { length: 64 }),
    redirectUris: text('redirect_uris')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    clientName: varchar('client_name', { length: 255 }),
    grantTypes: text('grant_types')
      .array()
      .notNull()
      .default(sql`'{authorization_code,refresh_token}'::text[]`),
    responseTypes: text('response_types')
      .array()
      .notNull()
      .default(sql`'{code}'::text[]`),
    tokenEndpointAuthMethod: varchar('token_endpoint_auth_method', { length: 50 })
      .notNull()
      .default('client_secret_post'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index('oauth_clients_created_at_idx').on(t.createdAt)],
);

export const authorizationCodes = pgTable(
  'authorization_codes',
  {
    code: varchar('code', { length: 255 }).primaryKey(),
    clientId: varchar('client_id', { length: 255 })
      .notNull()
      .references(() => oauthClients.clientId, { onDelete: 'cascade' }),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    redirectUri: varchar('redirect_uri', { length: 2048 }).notNull(),
    codeChallenge: varchar('code_challenge', { length: 255 }).notNull(),
    codeChallengeMethod: varchar('code_challenge_method', { length: 10 })
      .notNull()
      .default('S256'),
    scope: varchar('scope', { length: 1024 }),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    used: boolean('used').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index('authorization_codes_client_id_idx').on(t.clientId),
    index('authorization_codes_expires_at_idx').on(t.expiresAt),
  ],
);

export const revokedRefreshTokens = pgTable(
  'revoked_refresh_tokens',
  {
    jti: varchar('jti', { length: 64 }).primaryKey(),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index('revoked_refresh_tokens_expires_at_idx').on(t.expiresAt)],
);

export type OAuthClient = typeof oauthClients.$inferSelect;
export type NewOAuthClient = typeof oauthClients.$inferInsert;
export type AuthorizationCode = typeof authorizationCodes.$inferSelect;
export type NewAuthorizationCode = typeof authorizationCodes.$inferInsert;
export type RevokedRefreshToken = typeof revokedRefreshTokens.$inferSelect;
export type NewRevokedRefreshToken = typeof revokedRefreshTokens.$inferInsert;
