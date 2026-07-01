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

// White Crosmos logo, always shown on the dark email background.
const DARK_LOGO_SRC =
  'https://resend-attachments.s3.amazonaws.com/26bccd3d-9102-431f-9e78-71ba19267d1f';

/**
 * Shared chrome for the dark-only transactional emails. Every element carries
 * inline dark values as the universal baseline (so it renders dark even in
 * clients that ignore <style>), and the <style> block re-asserts them so
 * dark-mode clients and Outlook.com cannot invert it to light. Callers pass a
 * pre-escaped `preview` (the inbox preheader) plus already-rendered `body` and
 * `footer` HTML — the content and footer cells respectively.
 */
function renderDarkLayout(opts: { preview: string; body: string; footer: string }): string {
  return `<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd">
<html dir="ltr" lang="en" xmlns="http://www.w3.org/1999/xhtml" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta http-equiv="X-UA-Compatible" content="IE=edge" />
    <meta name="x-apple-disable-message-reformatting" />
    <meta name="format-detection" content="telephone=no,address=no,email=no,date=no,url=no" />
    <!-- Dark-only email. Declaring dark stops capable clients from inverting it to light. -->
    <meta name="color-scheme" content="dark" />
    <meta name="supported-color-schemes" content="dark" />
    <title>Crosmos</title>
    <!--[if mso]>
      <noscript><xml><o:OfficeDocumentSettings><o:PixelsPerInch>96</o:PixelsPerInch></o:OfficeDocumentSettings></xml></noscript>
    <![endif]-->
    <style>
      :root {
        color-scheme: dark;
        supported-color-schemes: dark;
      }

      /*
        Dark-only email. Dark values are set inline on every element (the
        universal baseline), so it renders dark everywhere, including clients
        that ignore <style>. The rules below simply re-assert those same dark
        values so dark-mode clients and Outlook.com cannot invert it to light.
        The logo is the white logo, always on the dark background.
      */
      @media (prefers-color-scheme: dark) {
        .dm-bg      { background-color: #0c0c0c !important; }
        .dm-text    { color: #eaeaea !important; }
        .dm-muted   { color: #9aa0a6 !important; }
        .dm-link    { color: #7ab3ff !important; }
        .dm-divider { border-top-color: #2a2a2a !important; }
      }

      /* Outlook.com / Office 365 dark mode */
      [data-ogsb] .dm-bg      { background-color: #0c0c0c !important; }
      [data-ogsc] .dm-text    { color: #eaeaea !important; }
      [data-ogsc] .dm-muted   { color: #9aa0a6 !important; }
      [data-ogsc] .dm-link    { color: #7ab3ff !important; }
      [data-ogsc] .dm-divider { border-top-color: #2a2a2a !important; }

      @media only screen and (max-width: 600px) {
        .footer-text { text-align: center !important; }
        .dm-button   { display: block !important; width: 100% !important; box-sizing: border-box !important; text-align: center !important; }
      }

      a { text-decoration: underline; }
    </style>
  </head>
  <body
    class="dm-bg"
    style="margin:0;padding:0;width:100%;background-color:#0c0c0c;-webkit-text-size-adjust:100%;-ms-text-size-adjust:100%"
  >
    <!-- Preheader: shown in the inbox preview, hidden in the body. -->
    <div style="display:none;overflow:hidden;line-height:1px;opacity:0;max-height:0;max-width:0" aria-hidden="true">
      ${opts.preview}
    </div>

    <table
      class="dm-bg"
      role="presentation"
      border="0"
      cellpadding="0"
      cellspacing="0"
      width="100%"
      style="background-color:#0c0c0c"
    >
      <tr>
        <td align="center" style="padding:0">
          <!--[if mso | IE]>
          <table role="presentation" border="0" cellpadding="0" cellspacing="0" width="600" align="center"><tr><td>
          <![endif]-->
          <table
            class="dm-bg dm-text"
            role="presentation"
            border="0"
            cellpadding="0"
            cellspacing="0"
            width="100%"
            style="max-width:600px;width:100%;background-color:#0c0c0c;color:#eaeaea;font-family:-apple-system, BlinkMacSystemFont, 'Segoe UI', 'Roboto', 'Oxygen', 'Ubuntu', 'Cantarell', 'Fira Sans', 'Droid Sans', 'Helvetica Neue', sans-serif;font-size:16px;line-height:1.55"
          >
            <tr>
              <td style="padding:36px 24px 4px 24px">
                <!-- LOGO — white logo on the dark email background (no swap, no plate). -->
                <img
                  alt="Crosmos"
                  width="280"
                  height="76"
                  src="${DARK_LOGO_SRC}"
                  style="display:block;width:280px;max-width:100%;height:auto;border:0;outline:none;text-decoration:none"
                />
              </td>
            </tr>

            <tr>
              <td class="dm-text" style="padding:24px 24px 0 24px;color:#eaeaea">
${opts.body}
              </td>
            </tr>

            <tr>
              <td style="padding:24px 24px 32px 24px">
${opts.footer}
              </td>
            </tr>
          </table>
          <!--[if mso | IE]>
          </td></tr></table>
          <![endif]-->
        </td>
      </tr>
    </table>
  </body>
</html>`;
}

/**
 * Bulletproof, table-based CTA button for the dark emails: a light fill with
 * dark text so it stands out on #0c0c0c, surviving Outlook and scaling to full
 * width on mobile via the `.dm-button` media-query rule. `href` is pre-encoded.
 */
function renderDarkButton(href: string, label: string): string {
  return `<table border="0" cellpadding="0" cellspacing="0" role="presentation" style="margin:8px 0 20px 0">
                  <tr>
                    <td align="center" style="border-radius:8px;background-color:#eaeaea">
                      <a class="dm-button" href="${href}" target="_blank" rel="noopener noreferrer" style="display:inline-block;padding:14px 32px;font-size:16px;font-weight:600;color:#0c0c0c;text-decoration:none;border-radius:8px">${label}</a>
                    </td>
                  </tr>
                </table>`;
}

/**
 * Dark-only welcome email, built on the shared dark layout. `name` is
 * pre-escaped HTML. `{{{RESEND_UNSUBSCRIBE_URL}}}` is a Resend merge tag left
 * intact for Resend to substitute at send time.
 */
function renderWelcomeHtml(name: string): string {
  const body = `<p style="margin:0 0 16px 0">Hey ${name},</p>

                <p style="margin:0 0 16px 0">Welcome to <strong>Crosmos</strong>.</p>

                <p style="margin:0 0 16px 0">
                  We built Crosmos because AI agents have the same problem every time they listen, respond, and forget.
                  The next conversation starts from zero. We fix that.
                </p>

                <p style="margin:0 0 16px 0">
                  <strong>The Console</strong>: This is where you manage everything. Create memory spaces, generate API
                  keys, and track your usage. Think of it as mission control for your agent's memory.
                  <a class="dm-link" href="https://console.crosmos.dev" target="_blank" rel="noopener noreferrer" style="color:#7ab3ff;text-decoration:underline">console.crosmos.dev</a>
                </p>

                <p style="margin:0 0 16px 0">
                  <strong>Agent Plugins</strong>: The fastest way to give your coding agent memory. Install the plugin
                  and Crosmos recalls relevant project context when a session starts and captures your work
                  automatically as you go, with no manual saving. Available for Claude Code and Codex.
                  <a class="dm-link" href="https://docs.crosmos.dev/plugins" target="_blank" rel="noopener noreferrer" style="color:#7ab3ff;text-decoration:underline">docs.crosmos.dev/plugins</a>
                </p>

                <p style="margin:0 0 16px 0">
                  <strong>MCP Server</strong>: One command and your coding assistant gets persistent memory. Works with
                  Claude Code, Cursor, Windsurf, VS Code, Opencode or any MCP-compatible client. It remembers your
                  project context, your preferences, your decisions. Across sessions.
                </p>

                <p style="margin:0 0 16px 0">
                  <strong>SDK</strong>: Integrate Crosmos directly into your own applications. Our SDK makes it simple
                  to add persistent memory to any AI agent or LLM-powered app.
                </p>

                <p style="margin:0 0 16px 0">
                  Full setup guides and reference are in the docs:
                  <a class="dm-link" href="https://docs.crosmos.dev" target="_blank" rel="noopener noreferrer" style="color:#7ab3ff;text-decoration:underline">docs.crosmos.dev</a>
                </p>

                <p style="margin:0 0 16px 0">
                  Crosmos clicks the moment you feed it something real. Not test data. Not "hello world." Start there,
                  search for something inside it, and you'll see what we mean.
                </p>

                <p style="margin:24px 0 0 0"><strong>Crosmos Team</strong></p>`;
  const footer = `<hr class="dm-divider" style="width:100%;border:none;border-top:1px solid #2a2a2a;margin:0 0 16px 0" />
                <p class="footer-text dm-muted" style="margin:0;font-size:13px;line-height:1.6;color:#9aa0a6;text-align:left">
                  You are receiving this email because you opted in via our site.<br /><br />
                  Want to change how you receive these emails?<br />
                  You can
                  <a
                    class="dm-link"
                    href="{{{RESEND_UNSUBSCRIBE_URL}}}"
                    target="_blank"
                    rel="noopener noreferrer"
                    ses:no-track="true"
                    style="color:#7ab3ff;text-decoration:underline"
                    >unsubscribe from this list</a
                  >.
                </p>`;
  return renderDarkLayout({
    preview: "One command is all it takes. Let's get started.",
    body,
    footer,
  });
}

function renderWelcomeText(name: string): string {
  return `Hey ${name},

Welcome to Crosmos.

We built Crosmos because AI agents have the same problem every time they listen, respond, and forget. The next conversation starts from zero. We fix that.

The Console: This is where you manage everything. Create memory spaces, generate API keys, and track your usage. Think of it as mission control for your agent's memory. https://console.crosmos.dev

Agent Plugins: The fastest way to give your coding agent memory. Install the plugin and Crosmos recalls relevant project context when a session starts and captures your work automatically as you go, with no manual saving. Available for Claude Code and Codex. https://docs.crosmos.dev/plugins

MCP Server: One command and your coding assistant gets persistent memory. Works with Claude Code, Cursor, Windsurf, VS Code, Opencode or any MCP-compatible client. It remembers your project context, your preferences, your decisions. Across sessions.

SDK: Integrate Crosmos directly into your own applications. Our SDK makes it simple to add persistent memory to any AI agent or LLM-powered app.

Full setup guides and reference are in the docs: https://docs.crosmos.dev

Crosmos clicks the moment you feed it something real. Not test data. Not "hello world." Start there, search for something inside it, and you'll see what we mean.

Crosmos Team
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
  const body = `<p style="margin:0 0 16px 0">Hi there,</p>

                <p style="margin:0 0 16px 0"><strong>${input.inviterName}</strong> invited you to join <strong>${input.orgName}</strong> on Crosmos as <strong>${input.role}</strong>.</p>

                <p style="margin:0 0 20px 0">Crosmos is the AI memory engine that gives your team's agents persistent, shared memory. Accept the invite to get access to this organization's memory spaces.</p>

                ${renderDarkButton(input.acceptUrl, 'Accept invitation')}

                <p class="dm-muted" style="margin:0 0 8px 0;font-size:14px;line-height:1.6;color:#9aa0a6">This invitation expires on ${input.expiresAt}. If the button above doesn't work, copy and paste this link into your browser:</p>

                <p style="margin:0;font-size:14px;line-height:1.6;word-break:break-all"><a class="dm-link" href="${input.acceptUrl}" style="color:#7ab3ff;text-decoration:underline">${input.acceptUrl}</a></p>`;
  const footer = `<hr class="dm-divider" style="width:100%;border:none;border-top:1px solid #2a2a2a;margin:0 0 16px 0" />
                <p class="footer-text dm-muted" style="margin:0;font-size:13px;line-height:1.6;color:#9aa0a6;text-align:left">
                  If you weren't expecting this invitation, you can safely ignore this email.
                </p>`;
  return renderDarkLayout({
    preview: `${input.inviterName} invited you to join ${input.orgName} on Crosmos.`,
    body,
    footer,
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
