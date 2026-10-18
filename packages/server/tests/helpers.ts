import { createServer } from "node:net"
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

/**
 * A port that was free when asked, for a test that needs the server's origin before it starts.
 * Otherwise start the server on port 0 and read `getPort()`.
 */
export async function getFreePort(): Promise<number> {
  return await new Promise<number>((resolvePromise, reject) => {
    const listener = createServer()
    listener.once("error", reject)
    listener.listen(0, "127.0.0.1", () => {
      const address = listener.address()
      if (!address || typeof address === "string") {
        reject(new Error("Could not resolve an open port"))
        return
      }
      listener.close((error) => (error ? reject(error) : resolvePromise(address.port)))
    })
  })
}

/**
 * The next JSON message on a socket. Call it before the message can arrive: Bun can deliver a
 * local frame before a listener added after `send()` observes it.
 */
export async function nextWsMessage(
  ws: WebSocket,
  timeoutMs = 3_000
): Promise<Record<string, unknown>> {
  return await new Promise((resolvePromise, reject) => {
    const timeout = setTimeout(() => {
      cleanup()
      reject(new Error("Timed out waiting for websocket message"))
    }, timeoutMs)
    const onMessage = (event: MessageEvent) => {
      cleanup()
      try {
        const data =
          event.data instanceof ArrayBuffer ? new TextDecoder().decode(event.data) : event.data
        resolvePromise(JSON.parse(String(data)) as Record<string, unknown>)
      } catch (error) {
        reject(error)
      }
    }
    const onError = () => {
      cleanup()
      reject(new Error("WebSocket error"))
    }
    const cleanup = () => {
      clearTimeout(timeout)
      ws.removeEventListener("message", onMessage)
      ws.removeEventListener("error", onError)
    }
    ws.addEventListener("message", onMessage)
    ws.addEventListener("error", onError)
  })
}
