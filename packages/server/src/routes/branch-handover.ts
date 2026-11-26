import { timingSafeEqual } from "node:crypto"
import type { SixbHostView } from "@sixb/core"
import { getRequestClientAddress } from "@sixb/core/internal/auth"
import {
  BRANCH_HANDOVER_PREPARE_PATH,
  BRANCH_HANDOVER_SIGN_IN_PATH,
  BRANCH_KEY_HEADER,
  BranchHandover,
} from "@sixb/core/internal/branches"
import type { Elysia } from "elysia"
import { z } from "zod"
import { htmlMessageResponse, sessionCallbackCompletionResponse } from "./auth"

const PersonSchema = z.object({
  id: z.string().min(1),
  email: z.string().min(3),
  displayName: z.string().nullable(),
  groupIds: z.array(z.string()),
})

/**
 * A branch production runs: how a person gets in. Production, with the branch's key, asks for a
 * code for a person it let open the branch; that person's browser trades the code, on the
 * branch's own origin, for a session of the branch's. Nothing else signs anyone in here: the
 * project's strategy is replaced by one that signs nobody in (`branchHandoverAuth`).
 * `packages/core/src/branches/handover.ts` holds the codes.
 */
export function registerBranchHandoverRoutes(
  app: Elysia,
  host: SixbHostView,
  options: { readonly key: string; readonly apiOrigin: (request: Request) => string }
) {
  const handover = new BranchHandover(host)
  const key = Buffer.from(options.key)
  const fromProduction = (request: Request) => {
    const given = Buffer.from(request.headers.get(BRANCH_KEY_HEADER) ?? "")
    return given.length === key.length && timingSafeEqual(given, key)
  }

  return app
    .post(
      BRANCH_HANDOVER_PREPARE_PATH,
      async ({ request, body, set }) => {
        if (!fromProduction(request)) {
          set.status = 401
          return { error: "Only production prepares a session here." }
        }

        const person = PersonSchema.safeParse(body)
        if (!person.success) {
          set.status = 400
          return { error: "A handover names the person: id, email, displayName and groupIds." }
        }

        try {
          const prepared = await handover.prepare(person.data)
          return { code: prepared.code, expiresAt: prepared.expiresAt.toISOString() }
        } catch (error) {
          set.status = 403
          return { error: error instanceof Error ? error.message : String(error) }
        }
      },
      { detail: { hide: true } }
    )
    .get(
      BRANCH_HANDOVER_SIGN_IN_PATH,
      async ({ request }) => {
        const code = new URL(request.url).searchParams.get("code") ?? ""
        const session = await handover.exchange(code, {
          userAgent: request.headers.get("user-agent")?.trim() || undefined,
          ipAddress: getRequestClientAddress(request),
        })
        if (!session) {
          return htmlMessageResponse(
            "This link was used already, or it expired. Open the branch again from production.",
            400,
            "You can't sign in"
          )
        }

        return sessionCallbackCompletionResponse({
          host,
          request,
          apiOrigin: options.apiOrigin(request),
          sessionCredential: session.credential,
          expiresAt: session.expiresAt,
          returnTo: "/",
        })
      },
      { detail: { hide: true } }
    )
}
