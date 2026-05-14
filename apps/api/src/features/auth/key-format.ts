import { sha256Hex, tokenHex } from '../../lib/crypto';

export const API_KEY_PREFIX = 'csk_';
export const API_KEY_PREFIX_LENGTH = 12;

export interface GeneratedApiKey {
  rawKey: string;
  keyHash: string;
  keyPrefix: string;
}

export async function generateApiKey(): Promise<GeneratedApiKey> {
  const rawKey = `${API_KEY_PREFIX}${tokenHex(16)}`;
  const keyHash = await sha256Hex(rawKey);
  const keyPrefix = rawKey.slice(0, API_KEY_PREFIX_LENGTH);
  return { rawKey, keyHash, keyPrefix };
}

export async function hashApiKey(rawKey: string): Promise<string> {
  return sha256Hex(rawKey);
}

export function isApiKey(token: string): boolean {
  return token.startsWith(API_KEY_PREFIX);
}
