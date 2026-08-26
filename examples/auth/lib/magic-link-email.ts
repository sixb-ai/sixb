export interface AcmeMagicLinkEmailInput {
  readonly subject: string
  readonly url: string
}

export interface AcmeMagicLinkEmail {
  readonly subject: string
  readonly text: string
  readonly html: string
}

const EMAIL_FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif"

/** Organization-owned presentation around the framework-owned sign-in URL. */
export function renderAcmeMagicLinkEmail(input: AcmeMagicLinkEmailInput): AcmeMagicLinkEmail {
  const safeSubject = escapeHtml(input.subject)
  const safeUrl = escapeHtml(input.url)

  return {
    subject: input.subject,
    text: [
      input.subject,
      "",
      "A secure sign-in was requested for your Acme Operations account.",
      "Open the link below to continue:",
      "",
      input.url,
      "",
      "This link expires soon and works once. If you did not request it, you can ignore this email.",
    ].join("\n"),
    html: [
      "<!doctype html>",
      '<html lang="en">',
      "<head>",
      '<meta charset="utf-8">',
      '<meta name="viewport" content="width=device-width,initial-scale=1">',
      `<title>${safeSubject}</title>`,
      "</head>",
      '<body style="margin:0;background:#eef2ed;color:#15211c;">',
      '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#eef2ed;">',
      '<tr><td align="center" style="padding:56px 20px;">',
      '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:520px;background:#ffffff;border-radius:20px;overflow:hidden;">',
      '<tr><td style="height:8px;background:#173b2b;font-size:0;line-height:0;">&nbsp;</td></tr>',
      `<tr><td style="padding:40px;font-family:${EMAIL_FONT};">`,
      '<div style="display:inline-block;padding:9px 13px;border-radius:10px;background:#173b2b;color:#ffffff;font-size:16px;font-weight:800;">A</div>',
      '<p style="margin:28px 0 8px;color:#789085;font-size:12px;font-weight:700;letter-spacing:.12em;text-transform:uppercase;">Acme Operations</p>',
      '<h1 style="margin:0;color:#132019;font-size:32px;line-height:1.15;letter-spacing:-.03em;">Your secure sign-in link</h1>',
      '<p style="margin:18px 0 30px;color:#69766f;font-size:16px;line-height:1.6;">Continue to live operations, approvals, and shared team context. This link expires soon and works once.</p>',
      '<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>',
      '<td bgcolor="#173b2b" style="border-radius:12px;">',
      `<a href="${safeUrl}" style="display:inline-block;padding:15px 24px;font-family:${EMAIL_FONT};color:#ffffff;font-size:15px;font-weight:700;text-decoration:none;">Sign in to Acme</a>`,
      "</td>",
      "</tr></table>",
      '<p style="margin:30px 0 8px;color:#8a948f;font-size:12px;line-height:1.5;">If the button does not work, copy this link:</p>',
      `<p style="margin:0;word-break:break-all;font-size:12px;line-height:1.5;"><a href="${safeUrl}" style="color:#2f6d50;">${safeUrl}</a></p>`,
      '<p style="margin:32px 0 0;padding-top:24px;border-top:1px solid #e3e9e5;color:#8a948f;font-size:12px;line-height:1.5;">If you did not request this email, you can safely ignore it.</p>',
      "</td></tr>",
      "</table>",
      "</td></tr>",
      "</table>",
      "</body>",
      "</html>",
    ].join(""),
  }
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
}
