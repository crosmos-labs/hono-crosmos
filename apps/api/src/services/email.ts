const RESEND_API_URL = 'https://api.resend.com/emails';
const FROM_ADDRESS = 'Crosmos <hello@crosmos.ai>';

export async function sendWelcomeEmail(
  apiKey: string,
  input: { to: string; name: string },
): Promise<void> {
  if (!apiKey) return; // Resend not configured (e.g. local dev) — no-op
  const html = `<p>Hi ${escapeHtml(input.name)}, welcome to Crosmos!</p>`;
  const res = await fetch(RESEND_API_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: FROM_ADDRESS,
      to: input.to,
      subject: 'Welcome to Crosmos',
      html,
    }),
  });
  if (!res.ok) {
    // Don't throw — caller fires this via waitUntil and we don't want to surface errors to user.
    console.error('Resend welcome email failed', res.status, await res.text().catch(() => ''));
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
