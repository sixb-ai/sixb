import { describe, expect, test } from "bun:test"
import { renderAcmeMagicLinkEmail } from "../lib/magic-link-email"

describe("auth example magic-link email", () => {
  test("renders branded text and escaped email-safe HTML around the supplied URL", () => {
    const url = "https://auth.example.com/auth/callback?token=one&audience=app"
    const email = renderAcmeMagicLinkEmail({
      subject: "Sign in to Acme <Operations>",
      url,
    })

    expect(email.subject).toBe("Sign in to Acme <Operations>")
    expect(email.text).toContain(url)
    expect(email.html).toContain("Acme Operations")
    expect(email.html).toContain("Sign in to Acme &lt;Operations&gt;")
    expect(email.html).toContain(
      'href="https://auth.example.com/auth/callback?token=one&amp;audience=app"'
    )
  })
})
