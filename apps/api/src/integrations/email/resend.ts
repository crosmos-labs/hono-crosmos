import type { EmailSender } from './port';
import { createLogger } from '@crosmos/observability';

const RESEND_API_URL = 'https://api.resend.com/emails';
const FROM_ADDRESS = 'Crosmos <hello@crosmos.dev>';

export class ResendEmailSender implements EmailSender {
  constructor(private readonly apiKey: string) {}

  async sendWelcome(input: { to: string; name: string }): Promise<void> {
    const res = await fetch(RESEND_API_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: FROM_ADDRESS,
        to: input.to,
        subject: 'Welcome to Crosmos',
        html: `<p>Hi ${escapeHtml(input.name)}, welcome to Crosmos!</p>`,
      }),
    });
    if (!res.ok) {
      // Callers fire this via waitUntil — never surface errors to the user.
      await res.text().catch(() => '');
      createLogger({ service: 'api' }).error('email.welcome_send_failed', {
        provider: 'resend',
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
