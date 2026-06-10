/**
 * Email transport — the interface features call.
 *
 * Implementations: see `./resend.ts` (production) and `./noop.ts` (local dev
 * / tests when no API key is configured). Pick an implementation via
 * `getEmailSender(env)` from `./index.ts`. Features must not import a
 * concrete implementation directly.
 */
export interface EmailSender {
  sendWelcome(input: { to: string; name: string }): Promise<void>;
  sendInvite(input: {
    to: string;
    orgName: string;
    inviterName: string;
    role: string;
    acceptUrl: string;
    expiresAt: Date;
  }): Promise<void>;
}
