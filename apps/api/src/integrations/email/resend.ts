import type { EmailSender } from './port';
import { createLogger } from '@crosmos/observability';

const RESEND_API_URL = 'https://api.resend.com/emails';
const DEFAULT_FROM_ADDRESS = 'Crosmos <hello@crosmos.dev>';

export class ResendEmailSender implements EmailSender {
  constructor(
    private readonly apiKey: string,
    private readonly fromAddress: string = DEFAULT_FROM_ADDRESS,
  ) {}

  async sendWelcome(input: { to: string; name: string }): Promise<void> {
    await this.send({
      to: input.to,
      subject: 'Welcome to Crosmos',
      html: `<p>Hi ${escapeHtml(input.name)}, welcome to Crosmos!</p>`,
      event: 'welcome',
    });
  }

  async sendInvite(input: {
    to: string;
    orgName: string;
    inviterName: string;
    role: string;
    acceptUrl: string;
    expiresAt: Date;
  }): Promise<void> {
    await this.send({
      to: input.to,
      subject: `You're invited to ${input.orgName}`,
      html: [
        `<p>${escapeHtml(input.inviterName)} invited you to join ${escapeHtml(input.orgName)} as ${escapeHtml(input.role)}.</p>`,
        `<p><a href="${escapeHtml(input.acceptUrl)}">Accept invite</a></p>`,
        `<p>This invite expires at ${escapeHtml(input.expiresAt.toISOString())}.</p>`,
      ].join(''),
      event: 'invite',
    });
  }

  private async send(input: {
    to: string;
    subject: string;
    html: string;
    event: string;
  }): Promise<void> {
    const res = await fetch(RESEND_API_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: this.fromAddress,
        to: input.to,
        subject: input.subject,
        html: input.html,
      }),
    });
    if (!res.ok) {
      // Callers fire this via waitUntil — never surface errors to the user.
      await res.text().catch(() => '');
      createLogger({ service: 'api' }).error('email.send_failed', {
        provider: 'resend',
        event: input.event,
        status_code: res.status,
      });
    }
  }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => {
    switch (c) {
      case '&': return '&amp;';
      case '<': return '&lt;';
      case '>': return '&gt;';
      case '"': return '&quot;';
      default: return '&#39;';
    }
  });
}
