import type { SixbApiBrowserPolicy } from "../src"

interface TestApp {
  fetch(request: Request): Response | Promise<Response>
}

export function linkFromLatestMessage(messages: readonly { readonly text: string }[]): URL {
  const text = messages.at(-1)?.text ?? ""
  const match = text.match(/https?:\/\/\S+/)
  if (!match) {
    throw new Error("No magic link found in sent email")
  }
  return new URL(match[0])
}

// Emulates a user opening the emailed magic link: GET the confirmation page,
// then submit its form. The GET must never consume the single-use token.
export async function confirmCallback(app: TestApp, link: URL): Promise<Response> {
  const confirm = await app.fetch(new Request(link.toString(), { redirect: "manual" }))
  if (confirm.status !== 200) {
    throw new Error(`Expected confirmation page, got ${confirm.status}`)
  }
  const html = await confirm.text()
  const body = new URLSearchParams()
  for (const name of ["magicLinkId", "token"]) {
    const match = html.match(new RegExp(`name="${name}" value="([^"]+)"`))
    const value = match?.[1] ?? link.searchParams.get(name)
    if (!value) {
      throw new Error(`Confirmation form is missing the ${name} field`)
    }
    body.set(name, value)
  }
  return app.fetch(
    new Request(new URL("/auth/callback", link).toString(), {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        // Browsers send the page origin on form POST navigations; the
        // browser-origin guard must accept this same-origin submission.
        origin: link.origin,
      },
      body,
      redirect: "manual",
    })
  )
}

export function createTestBrowserPolicy(
  options: { readonly apiOrigin?: string; readonly appOrigin?: string } = {}
): SixbApiBrowserPolicy {
  return {
    publicOrigin: options.apiOrigin ?? "http://api.localhost",
    allowedOrigins: [options.appOrigin ?? "http://app.localhost"],
  }
}
