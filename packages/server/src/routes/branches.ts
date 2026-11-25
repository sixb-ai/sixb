import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { SixbHostView } from "@sixb/core"
import { isAllowed } from "@sixb/core/internal/authorization"
import { copyForBranch } from "@sixb/core/internal/branches"
import { dropLakeSlice, issueLakeSliceToken } from "@sixb/core/internal/lake-slices"
import type { Elysia } from "elysia"
import { requireRequestSixb } from "../auth/scope"

interface BranchRouteContext {
  readonly request: Request
  readonly body?: unknown
  readonly set: { status?: number | string }
}

/**
 * What `sixb dev --from production` asks production for, as the signed-in person: the copy of
 * what they read, a new token for the lake slice it cut, and the slice's deletion when the copy
 * could not be loaded. Only the CLI calls them, with its own session: hidden from OpenAPI.
 */
export function registerBranchRoutes(app: Elysia, host: SixbHostView) {
  return app
    .post("/api/branches/copy", (context) => copyResponse(host, context), {
      detail: { hide: true },
    })
    .post("/api/branches/lake-token", (context) => lakeTokenResponse(host, context), {
      detail: { hide: true },
    })
    .delete("/api/branches/slices/:sliceId", (context) => dropSliceResponse(host, context), {
      detail: { hide: true },
    })
}

async function copyResponse(
  host: SixbHostView,
  { request, body: payload, set }: BranchRouteContext
) {
  const session = await host.auth.getSession(request, { credentialSource: "any" })
  if (!session.authenticated) {
    set.status = 401
    return { error: "[SixbServer] Sign in with `sixb login` to copy production's data." }
  }

  const person = host.auth.contextFromSession(session)
  if (!isAllowed(person, { kind: "source.manage" })) {
    set.status = 403
    return {
      error:
        "[SixbServer] Copying production's data to a branch takes can.manage(project.source). Ask an administrator for it.",
    }
  }

  const branch = fieldsOf(payload).branch
  if (typeof branch !== "string" || branch.trim().length === 0) {
    set.status = 400
    return { error: "[SixbServer] Name the git branch the copy is for: { branch }." }
  }

  const directory = await mkdtemp(join(tmpdir(), "sixb-branch-copy-"))
  const parts = copyForBranch(host, {
    person,
    branch,
    requestId: `branch_copy_${crypto.randomUUID()}`,
    directory,
    credential:
      session.credentialSource === "session"
        ? { type: "session", id: session.session.id }
        : { type: "accessToken", id: session.accessToken.id },
  })
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await parts.next()
        if (next.done) {
          controller.close()
          await rm(directory, { recursive: true, force: true })
        } else controller.enqueue(next.value)
      } catch (error) {
        controller.error(error)
        await rm(directory, { recursive: true, force: true })
      }
    },
    async cancel() {
      await parts.return(undefined)
      await rm(directory, { recursive: true, force: true })
    },
  })

  return new Response(body, { headers: { "content-type": "application/octet-stream" } })
}

async function lakeTokenResponse(host: SixbHostView, context: BranchRouteContext) {
  const sliceId = fieldsOf(context.body).sliceId
  if (typeof sliceId !== "string") {
    context.set.status = 400
    return { error: "[SixbServer] Name the lake slice: { sliceId }." }
  }

  const { token, expiresAt } = await issueLakeSliceToken(host, requireRequestSixb(context), {
    sliceId,
  })
  return { token, expiresAt: expiresAt.toISOString() }
}

async function dropSliceResponse(
  host: SixbHostView,
  context: BranchRouteContext & { readonly params: { readonly sliceId: string } }
) {
  const sixb = requireRequestSixb(context)
  const userId = sixb.execution.requestedBy?.type === "user" ? sixb.execution.requestedBy.id : null
  const slice = await host.storage.lakeSlices?.get({
    projectId: host.id,
    id: context.params.sliceId,
  })

  // A person deletes only their own slice; another's is not theirs to know of.
  if (slice && slice.userId === userId) await dropLakeSlice(host, slice.id)
  context.set.status = 204
  return null
}

function fieldsOf(body: unknown): Record<string, unknown> {
  return typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {}
}
