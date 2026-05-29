export interface SendMagicLinkInput {
  readonly email: string
  readonly url: string
  readonly from?: string
  readonly subject: string
  readonly text: string
  readonly html: string
}

export function createMagicLinkEmail(input: {
  readonly email: string
  readonly from?: string
  readonly link: string
  readonly subject: string
}): SendMagicLinkInput {
  return {
    email: input.email,
    url: input.link,
    from: input.from,
    subject: input.subject,
    text: [
      input.subject,
      "",
      "Click the link below to sign in. It expires soon and can be used once.",
      "",
      input.link,
      "",
      "If you didn't request this email, you can safely ignore it.",
    ].join("\n"),
    html: renderMagicLinkHtml(input.subject, input.link),
  }
}

// Email-client-safe HTML: table layout, inline styles, and a system font stack. A dark,
// centered, single-action layout that mirrors the in-app sign-in page's dark theme.
const EMAIL_FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif"

function renderMagicLinkHtml(subject: string, link: string): string {
  const safeSubject = escapeHtml(subject)
  const safeLink = escapeHtml(link)

  return [
    "<!doctype html>",
    '<html lang="en">',
    "<head>",
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<meta name="color-scheme" content="dark">',
    '<meta name="supported-color-schemes" content="dark">',
    `<title>${safeSubject}</title>`,
    "</head>",
    '<body style="margin:0;padding:0;background-color:#0a0a0a;">',
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#0a0a0a;">',
    "<tr>",
    '<td align="center" style="padding:64px 24px;">',
    '<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="width:100%;max-width:440px;table-layout:fixed;">',
    "<tr>",
    `<td align="center" style="font-family:${EMAIL_FONT};color:#f4f4f4;">`,
    `<h1 style="margin:0 0 16px;font-size:30px;line-height:1.2;font-weight:600;letter-spacing:-0.02em;color:#ffffff;">${safeSubject}</h1>`,
    '<p style="margin:0 0 40px;font-size:15px;line-height:1.6;color:#8a8a8a;">Click the button below to sign in. This link expires soon and can be used once.</p>',
    '<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0 auto;">',
    "<tr>",
    '<td align="center" bgcolor="#ffffff" style="border-radius:999px;">',
    `<a href="${safeLink}" style="display:inline-block;padding:14px 36px;font-family:${EMAIL_FONT};font-size:15px;font-weight:600;line-height:1;color:#0a0a0a;text-decoration:none;border-radius:999px;">Sign in</a>`,
    "</td>",
    "</tr>",
    "</table>",
    '<p style="margin:40px 0 6px;font-size:13px;line-height:1.6;color:#6b6b6b;">Or paste this link into your browser:</p>',
    `<p style="margin:0;font-size:13px;line-height:1.6;word-break:break-all;overflow-wrap:anywhere;"><a href="${safeLink}" style="color:#8a8a8a;text-decoration:underline;">${safeLink}</a></p>`,
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td style="padding:40px 0;"><div style="height:1px;background-color:#262626;line-height:1px;font-size:0;">&nbsp;</div></td></tr></table>',
    '<p style="margin:0;font-size:13px;line-height:1.6;color:#6b6b6b;">If you didn\'t request this email, you can safely ignore it.</p>',
    "</td>",
    "</tr>",
    "</table>",
    "</td>",
    "</tr>",
    "</table>",
    "</body>",
    "</html>",
  ].join("")
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
}
