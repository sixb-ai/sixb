import { createHmac, timingSafeEqual } from "node:crypto"
import type { SixbHostView } from "@sixb/core"
import type { Elysia } from "elysia"

/** Where the repository's push webhook points: GitHub signs each delivery with its secret. */
export const SOURCE_WEBHOOK_PATH = "/api/source/github"

/**
 * A push to a branch with a runtime tells that runtime to pull now. The signature is the
 * credential; a push to anything else, or for another repository, changes nothing.
 */
export function registerSourceWebhookRoutes(app: Elysia, host: SixbHostView) {
  return app.post(
    SOURCE_WEBHOOK_PATH,
    async ({ request, set }) => {
      const { source } = host
      const branches = host.storage.branches
      if (!source?.webhookSecret || !branches) {
        set.status = 404
        return { error: "[Sixb] This project takes no source webhook." }
      }
      const body = await request.text()
      if (!signedBy(source.webhookSecret, body, request.headers.get("x-hub-signature-256"))) {
        set.status = 401
        return { error: "[Sixb] The delivery's signature doesn't match." }
      }
      if (request.headers.get("x-github-event") !== "push") return { received: true }

      const push = parsePush(body)
      if (!push || push.repository.toLowerCase() !== source.repository.toLowerCase()) {
        return { received: true }
      }
      const name = push.ref.slice("refs/heads/".length)
      const now = new Date()
      await branches.update({ projectId: host.id, name, at: now }, { pushedAt: now })
      return { received: true }
    },
    { parse: "none", detail: { hide: true } }
  )
}

function signedBy(secret: string, body: string, header: string | null): boolean {
  if (!header?.startsWith("sha256=")) return false
  const expected = Buffer.from(`sha256=${createHmac("sha256", secret).update(body).digest("hex")}`)
  const given = Buffer.from(header)
  return given.length === expected.length && timingSafeEqual(given, expected)
}

function parsePush(body: string): { readonly ref: string; readonly repository: string } | null {
  try {
    const payload = JSON.parse(body) as {
      readonly ref?: unknown
      readonly repository?: { readonly full_name?: unknown }
    }
    const { ref } = payload
    const repository = payload.repository?.full_name
    if (typeof ref !== "string" || !ref.startsWith("refs/heads/")) return null
    return typeof repository === "string" ? { ref, repository } : null
  } catch {
    return null
  }
}
