// Sends transactional email through Postmark's HTTP API (no extra packages).
//
// Why a transactional provider and not the server's own mail: its sending addresses already have a good
// reputation with Gmail, Outlook and the rest, and it handles bounces and complaints. A new VPS address
// would be blocked or sent to spam.
//
// Deliverability checklist (done once, in DNS and at the provider; see the user guide):
//  - send from a dedicated subdomain (e.g. notify.sovfren.org), not the main domain
//  - verify the domain with the provider: SPF and DKIM records, plus a DMARC record
//  - MAIL_FROM must be an address on that verified domain, and is always our own address, never the sender's
//  - keep messages short and plain: no attachments, no link shorteners, no tracking pixels, one link on our own domain
//
// Configure with POSTMARK_TOKEN and MAIL_FROM. If either is missing, nothing is sent and the caller is told, so the
// person offering the instrument can pass the link on by hand instead.

const env = (name: 'POSTMARK_TOKEN' | 'MAIL_FROM'): string | undefined => process.env[name] || (import.meta as any).env?.[name] || undefined;

export interface MailResult {
  sent: boolean;
  reason?: string;
}

export const mailConfigured = () => !!env('POSTMARK_TOKEN') && !!env('MAIL_FROM');

export async function sendMail(m: { to: string; subject: string; text: string; html: string }): Promise<MailResult> {
  const token = env('POSTMARK_TOKEN');
  const from = env('MAIL_FROM');
  if (!token || !from) return { sent: false, reason: 'Email is not set up on this server yet.' };
  try {
    const res = await fetch('https://api.postmarkapp.com/email', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'X-Postmark-Server-Token': token },
      body: JSON.stringify({
        From: from,
        To: m.to,
        Subject: m.subject,
        TextBody: m.text,
        HtmlBody: m.html,
        MessageStream: 'outbound',
        TrackOpens: false,
        TrackLinks: 'None',
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { Message?: string };
      return { sent: false, reason: `The email service refused it (${res.status}${body.Message ? `: ${body.Message}` : ''}).` };
    }
    return { sent: true };
  } catch {
    return { sent: false, reason: 'Could not reach the email service.' };
  }
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

/** The message that carries the one-time link. Short and plain, with no amounts in it. */
export function offerEmail(opts: { senderName: string; link: string; expires: string }) {
  const text = [
    `${opts.senderName} has shared an electronic document with you through the Sovfren Society Electronic Trade Register.`,
    '',
    `To read it and accept it, open this secure link. It can be used once, and works until ${opts.expires}:`,
    opts.link,
    '',
    'If this was not meant for you, please tell the sender. Nothing happens unless you open the link and accept.',
    '',
    'Sovfren Society · sovfren.org',
  ].join('\n');
  const html =
    `<div style="font-family:system-ui,Segoe UI,Arial,sans-serif;max-width:34rem;color:#0f172a;line-height:1.5">` +
    `<p><strong>${esc(opts.senderName)}</strong> has shared an electronic document with you through the Sovfren Society Electronic Trade Register.</p>` +
    `<p>To read it and accept it, open this secure link. It can be used once, and works until ${esc(opts.expires)}:</p>` +
    `<p><a href="${esc(opts.link)}">${esc(opts.link)}</a></p>` +
    `<p style="color:#5f728c">If this was not meant for you, please tell the sender. Nothing happens unless you open the link and accept.</p>` +
    `<p style="color:#5f728c">Sovfren Society · sovfren.org</p></div>`;
  return { subject: 'A document has been shared with you on Sovfren', text, html };
}
