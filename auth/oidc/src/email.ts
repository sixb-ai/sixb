export interface SendOidcInvitationInput {
  readonly email: string
  readonly url: string
  readonly from?: string
  readonly subject: string
  readonly text: string
  readonly html: string
}

export function createOidcInvitationEmail(input: {
  readonly email: string
  readonly from?: string
  readonly url: string
  readonly subject: string
}): SendOidcInvitationInput {
  return {
    email: input.email,
    url: input.url,
    from: input.from,
    subject: input.subject,
    text: [
      "You have been invited to Pario.",
      "",
      "Use this link to sign in with your identity provider:",
      "",
      input.url,
      "",
      "If you were not expecting this invitation, you can ignore this email.",
    ].join("\n"),
    html: [
      "<p>You have been invited to Pario.</p>",
      `<p><a href="${escapeHtml(input.url)}">Sign in to Pario</a></p>`,
      "<p>If you were not expecting this invitation, you can ignore this email.</p>",
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
