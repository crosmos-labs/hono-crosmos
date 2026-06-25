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

// `name` is pre-escaped HTML.
function renderWelcomeHtml(name: string): string {
  return `<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd">
<html dir="ltr" lang="en">
  <head>
    <meta content="width=device-width" name="viewport" />
    <link
      rel="preload"
      as="image"
      href="https://resend-attachments.s3.amazonaws.com/bb8970a2-436c-4b5c-bb07-9723f7ee0732" />
    <link
      rel="preload"
      as="image"
      href="https://resend.com/static/email/social-linkedin.png" />
    <link
      rel="preload"
      as="image"
      href="https://resend.com/static/email/social-x.png" />
    <link
      rel="preload"
      as="image"
      href="https://resend.com/static/email/social-github.png" />
    <link
      rel="preload"
      as="image"
      href="https://resend.com/static/email/social-discord.png" />
    <meta content="text/html; charset=UTF-8" http-equiv="Content-Type" />
    <meta name="x-apple-disable-message-reformatting" />
    <meta content="IE=edge" http-equiv="X-UA-Compatible" />
    <meta name="x-apple-disable-message-reformatting" />
    <meta
      content="telephone=no,address=no,email=no,date=no,url=no"
      name="format-detection" />
  </head>
  <body
    style="background-color:#ffffff;padding-top:0;padding-bottom:0;padding-right:0;padding-left:0">
    <div
      style="display:none;overflow:hidden;line-height:1px;opacity:0;max-height:0;max-width:0"
      data-skip-in-text="true">
      Welcome to Crosmos — your AI memory engine is ready
    </div>
    <table
      border="0"
      width="100%"
      cellpadding="0"
      cellspacing="0"
      role="presentation"
      align="center">
      <tbody>
        <tr>
          <td
            style="font-family:-apple-system, BlinkMacSystemFont, 'Segoe UI', 'Roboto', 'Oxygen', 'Ubuntu', 'Cantarell', 'Fira Sans', 'Droid Sans', 'Helvetica Neue', sans-serif;font-size:1em;min-height:100%;line-height:155%;background-color:#ffffff;padding-top:0px;padding-right:0px;padding-bottom:0px;padding-left:0px">
            <table
              align="left"
              width="100%"
              border="0"
              cellpadding="0"
              cellspacing="0"
              role="presentation"
              style="max-width:600px;align:left;width:100%;color:#000000;background-color:#ffffff;padding-top:0px;padding-right:0px;padding-bottom:0px;padding-left:0px;border-radius:0px;border-color:#000000;line-height:155%">
              <tbody>
                <tr style="width:100%">
                  <td>
                    <p
                      style="margin:0;padding:0;font-size:1em;padding-top:8px;padding-bottom:8px;padding-right:8px;padding-left:8px">
                      <br />
                    </p>
                    <table
                      align="center"
                      width="100%"
                      border="0"
                      cellpadding="0"
                      cellspacing="0"
                      role="presentation">
                      <tbody style="width:100%">
                        <tr style="width:100%">
                          <td align="right" data-id="__react-email-column">
                            <img
                              alt="Crosmos"
                              height="37"
                              src="https://resend-attachments.s3.amazonaws.com/bb8970a2-436c-4b5c-bb07-9723f7ee0732"
                              style="display:block;outline:none;border:none;text-decoration:none;max-width:100%;border-radius:8px"
                              width="192" />
                          </td>
                        </tr>
                      </tbody>
                    </table>
                    <p
                      style="margin:0;padding:0;font-size:1em;padding-top:0px;padding-bottom:0px;padding-right:0px;padding-left:0px;line-height:120%">
                      <br />
                    </p>
                    <p
                      style="margin:0;padding:0;font-size:1em;padding-top:0.5em;padding-bottom:0.5em">
                      Hey ${name},
                    </p>
                    <p
                      style="margin:0;padding:0;font-size:1em;padding-top:0.5em;padding-bottom:0.5em">
                      Welcome to Crosmos! Your account is ready and you can start building AI agents with persistent memory right away.
                    </p>
                    <p
                      style="margin:0;padding:0;font-size:1em;padding-top:0.5em;padding-bottom:0.5em">
                      <strong>Quick Start Guide:</strong>
                    </p>
                    <ul style="margin:0;padding-left:20px;font-size:1em">
                      <li style="padding-top:0.3em;padding-bottom:0.3em"><strong>Create a Memory Space</strong> — Organize memories by project or use case</li>
                      <li style="padding-top:0.3em;padding-bottom:0.3em"><strong>Add Memories</strong> — Store facts, conversations, or documents via API</li>
                      <li style="padding-top:0.3em;padding-bottom:0.3em"><strong>Search & Retrieve</strong> — Query with semantic, keyword, or graph traversal</li>
                    </ul>
                    <p
                      style="margin:0;padding:0;font-size:1em;padding-top:0.5em;padding-bottom:0.5em">
                      Check out our <a href="https://docs.crosmos.dev" style="color:#0066cc;text-decoration:underline">documentation</a> for detailed guides, API references, and integration examples.
                    </p>
                    <p
                      style="margin:0;padding:0;font-size:1em;padding-top:0.5em;padding-bottom:0.5em">
                      If you have any questions, just reply to this email — we're here to help.
                    </p>
                    <p
                      style="margin:0;padding:0;font-size:1em;padding-top:0.5em;padding-bottom:0.5em">
                      <br />
                    </p>
                    <p
                      style="margin:0;padding:0;font-size:1em;padding-top:0.5em;padding-bottom:0.5em;line-height:0%">
                      Regards
                    </p>
                    <p
                      style="margin:0;padding:0;font-size:1em;padding-top:0.5em;padding-bottom:0.5em">
                      Team Crosmos
                    </p>
                    <p
                      style="margin:0;padding:0;font-size:1em;padding-top:0.5em;padding-bottom:0.5em">
                      <br />
                    </p>
                    <table
                      align="center"
                      width="100%"
                      border="0"
                      cellpadding="0"
                      cellspacing="0"
                      role="presentation">
                      <tbody>
                        <tr>
                          <td>
                            <table
                              align="center"
                              width="100%"
                              border="0"
                              cellpadding="0"
                              cellspacing="0"
                              role="presentation">
                              <tbody style="width:100%">
                                <tr style="width:100%">
                                  <td data-id="__react-email-column"></td>
                                  <td
                                    align="center"
                                    data-id="__react-email-column"
                                    style="padding-right:8px;width:32px;box-sizing:content-box">
                                    <a
                                      href="https://linkedin.com/company/crosmos-ai"
                                      rel="noopener noreferrer"
                                      target="_blank"
                                      ><img
                                        alt="LinkedIn"
                                        height="32"
                                        src="https://resend.com/static/email/social-linkedin.png"
                                        style="display:block;outline:none;border:none;text-decoration:none"
                                        width="32"
                                    /></a>
                                  </td>
                                  <td
                                    align="center"
                                    data-id="__react-email-column"
                                    style="padding-right:8px;width:32px;box-sizing:content-box">
                                    <a
                                      href="https://x.com/crosmoslabs"
                                      rel="noopener noreferrer"
                                      target="_blank"
                                      ><img
                                        alt="X (former Twitter)"
                                        height="32"
                                        src="https://resend.com/static/email/social-x.png"
                                        style="display:block;outline:none;border:none;text-decoration:none"
                                        width="32"
                                    /></a>
                                  </td>
                                  <td
                                    align="center"
                                    data-id="__react-email-column"
                                    style="padding-right:8px;width:32px;box-sizing:content-box">
                                    <a
                                      href="https://github.com/crosmos"
                                      rel="noopener noreferrer"
                                      target="_blank"
                                      ><img
                                        alt="GitHub"
                                        height="32"
                                        src="https://resend.com/static/email/social-github.png"
                                        style="display:block;outline:none;border:none;text-decoration:none"
                                        width="32"
                                    /></a>
                                  </td>
                                  <td
                                    align="center"
                                    data-id="__react-email-column"
                                    style="padding-right:8px;width:32px;box-sizing:content-box">
                                    <a
                                      href="https://discord.gg/Arw5ysGNN6"
                                      rel="noopener noreferrer"
                                      target="_blank"
                                      ><img
                                        alt="Discord"
                                        height="32"
                                        src="https://resend.com/static/email/social-discord.png"
                                        style="display:block;outline:none;border:none;text-decoration:none"
                                        width="32"
                                    /></a>
                                  </td>
                                  <td data-id="__react-email-column"></td>
                                </tr>
                              </tbody>
                            </table>
                          </td>
                        </tr>
                      </tbody>
                    </table>
                    <p
                      style="margin:0;padding:0;font-size:1em;padding-top:0.5em;padding-bottom:0.5em">
                      <br />
                    </p>
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

function renderWelcomeText(name: string): string {
  return `Hey ${name},

Welcome to Crosmos! Your account is ready and you can start building AI agents with persistent memory right away.

Quick Start Guide:
- Create a Memory Space — Organize memories by project or use case
- Add Memories — Store facts, conversations, or documents via API
- Search & Retrieve — Query with semantic, keyword, or graph traversal

Check out our documentation at https://docs.crosmos.dev for detailed guides, API references, and integration examples.

If you have any questions, just reply to this email — we're here to help.

Regards
Team Crosmos
`;
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
