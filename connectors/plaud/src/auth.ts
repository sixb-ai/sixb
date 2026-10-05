import { createHash, randomBytes, timingSafeEqual } from "node:crypto"
import { PlaudAuthError } from "./errors"
import { NATIVE_CLIENT_ID, NATIVE_REDIRECT_URI, tokenRequest } from "./oauth"
import { resolveTokenStore } from "./token-store"
import type { PlaudLoginOptions } from "./types"
import { integer, nonEmpty } from "./validation"

export { plaudFileTokenStore } from "./token-store"
export type { PlaudLoginOptions, PlaudTokenStore, PlaudTokens } from "./types"

/** Interactive native OAuth login. No password handling and no browser launched implicitly. */
export async function loginPlaud(options: PlaudLoginOptions): Promise<void> {
  const redirect = new URL(options.redirectUri ?? NATIVE_REDIRECT_URI)
  if (
    redirect.protocol !== "http:" ||
    !["localhost", "127.0.0.1", "[::1]"].includes(redirect.hostname) ||
    !redirect.port ||
    redirect.username ||
    redirect.password ||
    redirect.search ||
    redirect.hash
  )
    throw new Error(
      "[SixbPlaud] redirectUri must be an HTTP loopback URL with an explicit port and no query."
    )
  const clientId = nonEmpty(options.clientId ?? NATIVE_CLIENT_ID, "clientId")
  integer(options.timeoutMs ?? 30_000, 1, "timeoutMs")
  const signal = AbortSignal.any([
    ...(options.signal ? [options.signal] : []),
    AbortSignal.timeout(integer(options.loginTimeoutMs ?? 120_000, 1, "loginTimeoutMs")),
  ])
  signal.throwIfAborted()
  const store = resolveTokenStore(options)
  const verifier = randomBytes(32).toString("base64url")
  const state = randomBytes(32).toString("base64url")
  const authorizationUrl = new URL("https://web.plaud.ai/platform/oauth")
  authorizationUrl.search = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirect.href,
    response_type: "code",
    code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    code_challenge_method: "S256",
    state,
  }).toString()
  let finish!: () => void
  let fail!: (error: unknown) => void
  const done = new Promise<void>((resolve, reject) => {
    finish = resolve
    fail = reject
  })
  // Attach immediately: a callback or abort can arrive while the URL handler is running.
  void done.catch(() => {})
  let started = false
  const server = Bun.serve({
    hostname: redirect.hostname === "[::1]" ? "::1" : "127.0.0.1",
    port: Number(redirect.port),
    async fetch(request) {
      const url = new URL(request.url)
      if (request.method !== "GET" || url.pathname !== redirect.pathname)
        return new Response(null, { status: 404 })
      const provided = url.searchParams.get("state") ?? ""
      if (
        Buffer.byteLength(provided) !== Buffer.byteLength(state) ||
        !timingSafeEqual(Buffer.from(provided), Buffer.from(state))
      )
        return new Response("Invalid OAuth state.", { status: 400 })
      if (started) return new Response("Authorization already in progress.", { status: 409 })
      if (url.searchParams.has("error")) {
        fail(new PlaudAuthError("rejected", "Plaud authorization was denied."))
        return new Response("Authorization denied.", { status: 400 })
      }
      const code = url.searchParams.get("code")
      if (!code) return new Response("Missing authorization code.", { status: 400 })
      started = true
      try {
        const tokens = await tokenRequest(
          "oauth/third-party/access-token",
          {
            code,
            redirect_uri: redirect.href,
            code_verifier: verifier,
            state,
          },
          options,
          signal,
          Buffer.from(`${clientId}:${options.clientSecret ?? ""}`).toString("base64")
        )
        await store.withLock(() => store.save(tokens), signal)
        finish()
        return new Response("Plaud authorization successful. You can close this tab.")
      } catch {
        fail(
          new PlaudAuthError("rejected", "Authorization could not be saved. Run loginPlaud again.")
        )
        return new Response("Authorization failed. Return to your terminal.", { status: 500 })
      }
    },
  })
  const aborted = () => fail(signal.reason)
  signal.addEventListener("abort", aborted, { once: true })
  try {
    if (signal.aborted) aborted()
    await Promise.race([
      Promise.resolve().then(() => options.onAuthorizationUrl(authorizationUrl.href)),
      done,
    ])
    await done
  } finally {
    signal.removeEventListener("abort", aborted)
    await server.stop(true)
  }
}
