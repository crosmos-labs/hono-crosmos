import type { EmailSender } from './port';

/**
 * No-op email sender. Used when no provider API key is configured
 * (local development, tests). Makes the "email is optional in dev" rule
 * explicit instead of scattered `if (apiKey) { … }` checks across features.
 */
export class NoopEmailSender implements EmailSender {
  async sendWelcome(_input: { to: string; name: string }): Promise<void> {
    // intentionally empty
  }

  async sendInvite(_input: {
    to: string;
    orgName: string;
    inviterName: string;
    role: string;
    acceptUrl: string;
    expiresAt: Date;
  }): Promise<void> {
    // intentionally empty
  }
}
