function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]!);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function toHex(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i++) {
    s += bytes[i]!.toString(16).padStart(2, '0');
  }
  return s;
}

export function randomBytes(n: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(n));
}

export function tokenHex(bytes: number): string {
  return toHex(randomBytes(bytes));
}

export function tokenUrlSafe(bytes: number): string {
  return toBase64Url(randomBytes(bytes));
}

export async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const hash = await crypto.subtle.digest('SHA-256', data);
  return toHex(new Uint8Array(hash));
}

/**
 * BASE64URL(SHA-256(input)) — the PKCE `S256` code-challenge transform
 * (RFC 7636 §4.2). Used to verify a `code_verifier` against the stored
 * `code_challenge`.
 */
export async function sha256Base64Url(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const hash = await crypto.subtle.digest('SHA-256', data);
  return toBase64Url(new Uint8Array(hash));
}
