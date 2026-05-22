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
      "Use this link to sign in to Pario:",
      "",
      input.link,
      "",
      "If you did not request this email, you can ignore it.",
    ].join("\n"),
    html: [
      "<p>Use this link to sign in to Pario:</p>",
      `<p><a href="${escapeHtml(input.link)}">Sign in to Pario</a></p>`,
      "<p>If you did not request this email, you can ignore it.</p>",
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
