import "server-only";

// Transactional email (ADR-0012) through Resend's HTTPS API (https://resend.com/docs/api-reference/emails/send-email), with no
// SDK: one POST. Settings, server only: RESEND_API_KEY and EMAIL_FROM (a sender on a domain verified in Resend, for example
// "BabySunRay <hello@babysunray.com>"). Without both, nothing is sent and callers are told so: no feature pretends an email
// went out. The message body and the address are never logged; a failure logs the HTTP status only.

export type EmailMessage = { to: string; subject: string; text: string; html: string };
export type EmailSender = (message: EmailMessage) => Promise<void>;

export class EmailNotConfigured extends Error {
  override name = "EmailNotConfigured";
}
export class EmailFailed extends Error {
  override name = "EmailFailed";
}

type Env = Record<string, string | undefined>;
const FROM = /^(?:[^<>\r\n]{1,80} )?<?[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+>?$/;

/** The settings, or null when email is not set up; throws (naming variables, never values) when they are half set or malformed. */
export function emailSettings(env: Env): { apiKey: string; from: string } | null {
  const apiKey = env.RESEND_API_KEY?.trim() ?? "";
  const from = env.EMAIL_FROM?.trim() ?? "";
  if (!apiKey && !from) return null;
  if (!apiKey || !from) throw new EmailNotConfigured("RESEND_API_KEY and EMAIL_FROM must be set together.");
  if (!/^re_[A-Za-z0-9_]{8,}$/.test(apiKey)) throw new EmailNotConfigured("RESEND_API_KEY is not a Resend API key.");
  if (!FROM.test(from)) throw new EmailNotConfigured('EMAIL_FROM must be an address, or "Name <address>".');
  return { apiKey, from };
}

/** Whether email can be sent with these settings. Never throws. */
export function emailAvailable(env: Env = process.env): boolean {
  try {
    return emailSettings(env) !== null;
  } catch {
    return false;
  }
}

/** A sender for these settings (fetch injectable for tests). Throws EmailNotConfigured when email is not set up. */
export function emailSender(env: Env = process.env, send: typeof fetch = fetch): EmailSender {
  const settings = emailSettings(env);
  if (!settings) throw new EmailNotConfigured("Email is not set up (RESEND_API_KEY, EMAIL_FROM).");
  return async (message) => {
    let response: Response;
    try {
      response = await send("https://api.resend.com/emails", {
        method: "POST",
        headers: { authorization: `Bearer ${settings.apiKey}`, "content-type": "application/json" },
        body: JSON.stringify({ from: settings.from, to: [message.to], subject: message.subject, text: message.text, html: message.html }),
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      console.error(JSON.stringify({ level: "error", event: "email_failed", status: 0 }));
      throw new EmailFailed("The email could not be sent.");
    }
    if (!response.ok) {
      console.error(JSON.stringify({ level: "error", event: "email_failed", status: response.status }));
      throw new EmailFailed("The email could not be sent.");
    }
  };
}

const escape = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/** A plain bilingual message with one link or code: text and a minimal HTML version (everything escaped). */
export function simpleMessage(input: { to: string; subject: string; lines: string[]; link?: { url: string; label: string } }): EmailMessage {
  const text = [...input.lines, ...(input.link ? ["", input.link.url] : [])].join("\n");
  const html = `<div style="font-family:Arial,sans-serif;font-size:15px;line-height:1.5;color:#332923">${input.lines.map((l) => `<p>${escape(l)}</p>`).join("")}${
    input.link ? `<p><a href="${escape(input.link.url)}" style="display:inline-block;padding:12px 20px;background:#c28b56;color:#332923;border-radius:999px;text-decoration:none;font-weight:bold">${escape(input.link.label)}</a></p>` : ""
  }</div>`;
  return { to: input.to, subject: input.subject, text, html };
}
