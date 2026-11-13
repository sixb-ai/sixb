import { afterAll } from "bun:test"
import { GUEST_CREDENTIAL_PATHS } from "@sixb/core/sandboxes"
import { runSandboxCredentialsContractSuite } from "@sixb/core/testing"
import { liveEnabled, liveFactory } from "./live"

/**
 * Request credentials on real machines. A boxd machine runs remotely, so the suite's two servers
 * on this host must be reachable at two public HTTPS origins that forward to one local port, such
 * as two tunnels:
 *
 *   SIXB_BOXD_E2E=1 \
 *   SIXB_BOXD_CREDENTIALS_ORIGINS=https://a.example.dev,https://b.example.dev \
 *   SIXB_BOXD_CREDENTIALS_PORT=8000 \
 *   bun test --timeout 300000 ./sandboxes/boxd/tests/credentials.e2e.ts
 *
 * A router on that port hands each request to the suite's server for the origin it was sent to.
 */
const origins = (process.env.SIXB_BOXD_CREDENTIALS_ORIGINS ?? "")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean)
const port = Number(process.env.SIXB_BOXD_CREDENTIALS_PORT)

if (liveEnabled && origins.length === 2 && Number.isInteger(port)) {
  // The public host each origin arrives with, and the local port of the suite server behind it.
  const routes = new Map<string, number>()
  const router = Bun.serve({
    hostname: "0.0.0.0",
    port,
    async fetch(request) {
      const url = new URL(request.url)
      const target = routes.get(request.headers.get("host") ?? "")
      if (target === undefined) return new Response("Not found", { status: 404 })
      return fetch(`http://127.0.0.1:${target}${url.pathname}${url.search}`, {
        method: request.method,
        headers: request.headers,
        ...(request.method === "GET" || request.method === "HEAD" ? {} : { body: request.body }),
      })
    },
  })
  afterAll(() => router.stop(true))

  runSandboxCredentialsContractSuite("BoxdSandbox credentials (live)", {
    createFactory: () => liveFactory({ timeout: 60_000 }),
    originFor: (serverPort) => {
      const origin = origins[routes.size]
      if (origin === undefined) throw new Error("the suite asked for more than two origins")
      routes.set(new URL(origin).host, serverPort)
      return origin
    },
    privatePaths: [GUEST_CREDENTIAL_PATHS.state],
  })
}
