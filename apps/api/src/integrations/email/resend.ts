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
    const name = escapeHtml(input.name);
    await this.send({
      to: input.to,
      subject: WELCOME_EMAIL_SUBJECT,
      html: renderWelcomeHtml(name),
      text: renderWelcomeText(input.name),
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
      subject: `You're invited to join ${input.orgName} on Crosmos`,
      html: renderInviteHtml({
        orgName: escapeHtml(input.orgName),
        inviterName: escapeHtml(input.inviterName),
        role: escapeHtml(input.role),
        acceptUrl: encodeURI(input.acceptUrl),
        expiresAt: escapeHtml(formatExpiry(input.expiresAt)),
      }),
      text: renderInviteText(input),
      event: 'invite',
    });
  }

  private async send(input: {
    to: string;
    subject: string;
    html: string;
    text?: string;
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
        ...(input.text ? { text: input.text } : {}),
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

const WELCOME_EMAIL_SUBJECT = 'Welcome to Crosmos';

const LOGO_SRC =
  'https://resend-attachments.s3.amazonaws.com/bb8970a2-436c-4b5c-bb07-9723f7ee0732';
const BRAND_COLOR = '#0066cc';
const TEXT_COLOR = '#1a1a1a';
const MUTED_COLOR = '#6b7280';

/**
 * Shared HTML chrome (responsive container, logo, social footer) for every
 * transactional email. Callers pass a pre-escaped `preview` string and an
 * already-rendered `body` (the content between the logo and the footer).
 * The inline `<style>` media query is what gives us a comfortable reading
 * width on desktop and edge-to-edge padding on mobile.
 */
function renderLayout(opts: { preview: string; body: string }): string {
  return `<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd">
<html dir="ltr" lang="en">
  <head>
    <meta content="width=device-width, initial-scale=1.0" name="viewport" />
    <meta content="text/html; charset=UTF-8" http-equiv="Content-Type" />
    <meta content="IE=edge" http-equiv="X-UA-Compatible" />
    <meta name="x-apple-disable-message-reformatting" />
    <meta
      content="telephone=no,address=no,email=no,date=no,url=no"
      name="format-detection" />
    <link rel="preload" as="image" href="${LOGO_SRC}" />
    <link rel="preload" as="image" href="https://resend.com/static/email/social-linkedin.png" />
    <link rel="preload" as="image" href="https://resend.com/static/email/social-x.png" />
    <link rel="preload" as="image" href="https://resend.com/static/email/social-github.png" />
    <link rel="preload" as="image" href="https://resend.com/static/email/social-discord.png" />
    <style>
      @media only screen and (max-width: 600px) {
        .email-container { width: 100% !important; }
        .email-content { padding-left: 24px !important; padding-right: 24px !important; }
        .email-button { display: block !important; width: 100% !important; box-sizing: border-box !important; text-align: center !important; }
      }
    </style>
  </head>
  <body
    style="margin:0;padding:0;background-color:#f4f5f7;-webkit-text-size-adjust:100%;-ms-text-size-adjust:100%">
    <div
      style="display:none;overflow:hidden;line-height:1px;opacity:0;max-height:0;max-width:0"
      data-skip-in-text="true">
      ${opts.preview}
    </div>
    <table
      border="0"
      width="100%"
      cellpadding="0"
      cellspacing="0"
      role="presentation"
      style="background-color:#f4f5f7"
      align="center">
      <tbody>
        <tr>
          <td align="center" style="padding-top:24px;padding-bottom:24px">
            <table
              class="email-container"
              align="center"
              width="600"
              border="0"
              cellpadding="0"
              cellspacing="0"
              role="presentation"
              style="max-width:600px;width:100%;background-color:#ffffff;border-radius:12px">
              <tbody>
                <tr>
                  <td
                    class="email-content"
                    style="font-family:-apple-system, BlinkMacSystemFont, 'Segoe UI', 'Roboto', 'Oxygen', 'Ubuntu', 'Cantarell', 'Fira Sans', 'Droid Sans', 'Helvetica Neue', sans-serif;color:${TEXT_COLOR};font-size:16px;line-height:1.6;padding-top:32px;padding-bottom:32px;padding-left:40px;padding-right:40px">
                    <img
                      alt="Crosmos"
                      height="37"
                      src="${LOGO_SRC}"
                      style="display:block;outline:none;border:none;text-decoration:none;max-width:100%;border-radius:8px"
                      width="192" />
                    <div style="height:24px;line-height:24px">&nbsp;</div>
${opts.body}
                    <div style="height:32px;line-height:32px">&nbsp;</div>
                    <hr style="border:none;border-top:1px solid #e5e7eb;margin:0" />
                    <div style="height:24px;line-height:24px">&nbsp;</div>
                    ${renderSocialFooter()}
                  </td>
                </tr>
              </tbody>
            </table>
          </td>
        </tr>
      </tbody>
    </table>
  </body>
</html>`;
}

function renderSocialFooter(): string {
  return `<table
                      align="center"
                      width="100%"
                      border="0"
                      cellpadding="0"
                      cellspacing="0"
                      role="presentation">
                      <tbody style="width:100%">
                        <tr style="width:100%">
                          <td data-id="__react-email-column"></td>
                          <td align="center" style="padding-right:8px;width:32px;box-sizing:content-box">
                            <a href="https://linkedin.com/company/crosmos-ai" rel="noopener noreferrer" target="_blank"><img alt="LinkedIn" height="32" src="https://resend.com/static/email/social-linkedin.png" style="display:block;outline:none;border:none;text-decoration:none" width="32" /></a>
                          </td>
                          <td align="center" style="padding-right:8px;width:32px;box-sizing:content-box">
                            <a href="https://x.com/crosmoslabs" rel="noopener noreferrer" target="_blank"><img alt="X (former Twitter)" height="32" src="https://resend.com/static/email/social-x.png" style="display:block;outline:none;border:none;text-decoration:none" width="32" /></a>
                          </td>
                          <td align="center" style="padding-right:8px;width:32px;box-sizing:content-box">
                            <a href="https://github.com/crosmos" rel="noopener noreferrer" target="_blank"><img alt="GitHub" height="32" src="https://resend.com/static/email/social-github.png" style="display:block;outline:none;border:none;text-decoration:none" width="32" /></a>
                          </td>
                          <td align="center" style="padding-right:8px;width:32px;box-sizing:content-box">
                            <a href="https://discord.gg/Arw5ysGNN6" rel="noopener noreferrer" target="_blank"><img alt="Discord" height="32" src="https://resend.com/static/email/social-discord.png" style="display:block;outline:none;border:none;text-decoration:none" width="32" /></a>
                          </td>
                          <td data-id="__react-email-column"></td>
                        </tr>
                      </tbody>
                    </table>`;
}

/** Bulletproof, table-based CTA button that survives Outlook and scales to
 * full width on mobile via the `.email-button` media-query rule. */
function renderButton(href: string, label: string): string {
  return `<table border="0" cellpadding="0" cellspacing="0" role="presentation" style="margin:8px 0">
                      <tbody>
                        <tr>
                          <td align="center" style="border-radius:8px;background-color:${BRAND_COLOR}">
                            <a class="email-button" href="${href}" target="_blank" style="display:inline-block;padding:14px 32px;font-size:16px;font-weight:600;color:#ffffff;text-decoration:none;border-radius:8px">${label}</a>
                          </td>
                        </tr>
                      </tbody>
                    </table>`;
}

const P_STYLE = 'margin:0 0 16px 0;font-size:16px;line-height:1.6;color:' + TEXT_COLOR;

// `name` is pre-escaped HTML.
function renderWelcomeHtml(name: string): string {
  const body = `<p style="${P_STYLE}">Hey ${name},</p>
                    <p style="${P_STYLE}">Welcome to Crosmos. Your account is ready and you can start building AI agents with persistent memory right away.</p>
                    <p style="${P_STYLE}"><strong>Quick start guide</strong></p>
                    <ul style="margin:0 0 16px 0;padding-left:20px;font-size:16px;line-height:1.6;color:${TEXT_COLOR}">
                      <li style="padding-bottom:8px"><strong>Create a memory space.</strong> Organize memories by project or use case.</li>
                      <li style="padding-bottom:8px"><strong>Add memories.</strong> Store facts, conversations, or documents via API.</li>
                      <li style="padding-bottom:8px"><strong>Search and retrieve.</strong> Query with semantic, keyword, or graph traversal.</li>
                    </ul>
                    ${renderButton('https://docs.crosmos.dev', 'Read the docs')}
                    <p style="${P_STYLE}">You'll find detailed guides, API references, and integration examples there.</p>
                    <p style="${P_STYLE}">If you have any questions, just reply to this email. We're here to help.</p>
                    <p style="margin:0;font-size:16px;line-height:1.6;color:${TEXT_COLOR}">Regards,<br />Team Crosmos</p>`;
  return renderLayout({
    preview: 'Welcome to Crosmos. Your AI memory engine is ready.',
    body,
  });
}

function renderWelcomeText(name: string): string {
  return `Hey ${name},

Welcome to Crosmos. Your account is ready and you can start building AI agents with persistent memory right away.

Quick start guide:
- Create a memory space. Organize memories by project or use case.
- Add memories. Store facts, conversations, or documents via API.
- Search and retrieve. Query with semantic, keyword, or graph traversal.

Read the docs at https://docs.crosmos.dev for detailed guides, API references, and integration examples.

If you have any questions, just reply to this email. We're here to help.

Regards,
Team Crosmos
`;
}

// All fields are pre-escaped / encoded HTML.
function renderInviteHtml(input: {
  orgName: string;
  inviterName: string;
  role: string;
  acceptUrl: string;
  expiresAt: string;
}): string {
  const body = `<p style="${P_STYLE}">Hi there,</p>
                    <p style="${P_STYLE}"><strong>${input.inviterName}</strong> invited you to join <strong>${input.orgName}</strong> on Crosmos as <strong>${input.role}</strong>.</p>
                    <p style="${P_STYLE}">Crosmos is the AI memory engine that gives your team's agents persistent, shared memory. Accept the invite to get access to this organization's memory spaces.</p>
                    ${renderButton(input.acceptUrl, 'Accept invitation')}
                    <p style="margin:0 0 16px 0;font-size:14px;line-height:1.6;color:${MUTED_COLOR}">This invitation expires on ${input.expiresAt}. If the button above doesn't work, copy and paste this link into your browser:</p>
                    <p style="margin:0 0 16px 0;font-size:14px;line-height:1.6;word-break:break-all"><a href="${input.acceptUrl}" style="color:${BRAND_COLOR};text-decoration:underline">${input.acceptUrl}</a></p>
                    <p style="margin:0 0 16px 0;font-size:14px;line-height:1.6;color:${MUTED_COLOR}">If you weren't expecting this invitation, you can safely ignore this email.</p>
                    <p style="margin:0;font-size:16px;line-height:1.6;color:${TEXT_COLOR}">Regards,<br />Team Crosmos</p>`;
  return renderLayout({
    preview: `${input.inviterName} invited you to join ${input.orgName} on Crosmos.`,
    body,
  });
}

function renderInviteText(input: {
  orgName: string;
  inviterName: string;
  role: string;
  acceptUrl: string;
  expiresAt: Date;
}): string {
  return `Hi there,

${input.inviterName} invited you to join ${input.orgName} on Crosmos as ${input.role}.

Crosmos is the AI memory engine that gives your team's agents persistent, shared memory. Accept the invite to get access to this organization's memory spaces.

Accept the invitation:
${input.acceptUrl}

This invitation expires on ${formatExpiry(input.expiresAt)}.

If you weren't expecting this invitation, you can safely ignore this email.

Regards,
Team Crosmos
`;
}

/** Human-readable UTC timestamp, e.g. "June 30, 2026 at 14:32 UTC". */
function formatExpiry(date: Date): string {
  return (
    date.toLocaleString('en-US', {
      timeZone: 'UTC',
      month: 'long',
      day: 'numeric',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }) + ' UTC'
  );
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
