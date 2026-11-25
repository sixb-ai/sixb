import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { SixbHostView } from "@sixb/core"
import { isAllowed } from "@sixb/core/internal/authorization"
import {
  authorizeBranchCredential,
  branchCredentialSlice,
  copyForBranch,
} from "@sixb/core/internal/branches"
import { dropLakeSlice, issueLakeSliceToken } from "@sixb/core/internal/lake-slices"
import { resolveBranchMode } from "@sixb/core/internal/runtime"
import type { Elysia } from "elysia"
import { accessTokenSecurityRequirement } from "../auth/access-token-boundary"
import { requireRequestSixb } from "../auth/scope"
import { OPENAPI_TAGS } from "../openapi/tags"

interface BranchRouteContext {
  readonly request: Request
  readonly body?: unknown
  readonly set: { status?: number | string }
}

/**
 * What `sixb dev --from production` asks production for. The copy of what the person reads takes
 * the CLI's session or a personal access token: both are the person. With the credential the copy
 * gave it, which nothing else takes, the branch confirms it holds the copy whole, renews its lake
 * token and deletes its slice.
 */
export function registerBranchRoutes(app: Elysia, host: SixbHostView) {
  const detail = (operationId: string, summary: string) => ({
    summary,
    tags: [OPENAPI_TAGS.branches.name],
    operationId,
    security: accessTokenSecurityRequirement(operationId),
  })

  return (
    app
      .post("/api/branches/copy", (context) => copyResponse(host, context), {
        detail: detail(
          "copyForBranch",
          "Copy what you read for a branch: the snapshot, then the lake slice of the same moment"
        ),
      })
      // The branch's own credential calls these two; no client builds them.
      .post("/api/branches/lake-token", (context) => lakeTokenResponse(host, context), {
        detail: { hide: true },
      })
      .delete("/api/branches/slices/:sliceId", (context) => dropSliceResponse(host, context), {
        detail: { hide: true },
      })
      .post(
        "/api/branches/slices/:sliceId/received",
        (context) => receivedResponse(host, context),
        { detail: { hide: true } }
      )
  )
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
  const named = branchName(branch)
  if (named) {
    set.status = 400
    return { error: named }
  }

  // A copy holds a consistent read open in production: a few at a time, one per person. Counted
  // in this process: each server process of a project keeps its own count.
  const running = copiesRunning.get(host.id) ?? new Set<string>()
  if (running.size >= MAX_COPIES_PER_PROJECT || running.has(person.principal.id)) {
    set.status = 429
    return {
      error: running.has(person.principal.id)
        ? "[SixbServer] Your copy to a branch is still running. Try again once it ends."
        : `[SixbServer] ${running.size} copies to branches are running for this project. Try again in a minute.`,
    }
  }
  running.add(person.principal.id)
  copiesRunning.set(host.id, running)

  let directory: string | undefined
  let finished = false
  const finish = async () => {
    if (finished) return
    finished = true
    running.delete(person.principal.id)
    if (running.size === 0 && copiesRunning.get(host.id) === running) copiesRunning.delete(host.id)
    if (directory) await rm(directory, { recursive: true, force: true })
  }

  let parts: ReturnType<typeof copyForBranch>
  try {
    directory = await mkdtemp(join(tmpdir(), "sixb-branch-copy-"))
    parts = copyForBranch(host, {
      person,
      branch: branch as string,
      requestId: `branch_copy_${crypto.randomUUID()}`,
      directory,
      credential:
        session.credentialSource === "session"
          ? { type: "session", id: session.session.id }
          : { type: "accessToken", id: session.accessToken.id },
    })
  } catch (error) {
    await finish()
    throw error
  }

  // A branch that goes away mid-copy ends it: its read, its slice and its place in the limit.
  // One that went away before the copy started ends it now: its abort fired already.
  const abandon = () => void parts.return(undefined).finally(finish)
  if (request.signal.aborted) abandon()
  else request.signal.addEventListener("abort", abandon, { once: true })
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await parts.next()
        if (next.done) {
          controller.close()
          await finish()
        } else controller.enqueue(next.value)
      } catch (error) {
        controller.error(error)
        await finish()
      }
    },
    async cancel() {
      await parts.return(undefined)
      await finish()
    },
  })

  return new Response(body, { headers: { "content-type": "application/octet-stream" } })
}

/** The slice of the branch credential a request carries, or null: these routes take no other. */
async function credentialSlice(host: SixbHostView, request: Request) {
  return (await authorizeBranchCredential(host, bearerOf(request)))?.slice ?? null
}

function bearerOf(request: Request): string {
  const authorization = request.headers.get("authorization") ?? ""
  return authorization.startsWith("Bearer ") ? authorization.slice("Bearer ".length) : ""
}

async function lakeTokenResponse(host: SixbHostView, context: BranchRouteContext) {
  const slice = await credentialSlice(host, context.request)
  const sliceId = fieldsOf(context.body).sliceId
  if (!slice || sliceId !== slice.id) {
    context.set.status = 404
    return { error: "[SixbServer] This branch has no such lake slice. Take a new copy." }
  }

  try {
    const { token, expiresAt } = await issueLakeSliceToken(host, requireRequestSixb(context), {
      sliceId,
    })
    return { token, expiresAt: expiresAt.toISOString() }
  } catch (error) {
    // The person no longer reads a version of the slice in full: they take a new copy.
    context.set.status = 403
    return { error: error instanceof Error ? error.message : String(error) }
  }
}

/** Releasing reads nothing: the slice's credential may, whatever its person may still read. */
async function dropSliceResponse(
  host: SixbHostView,
  context: BranchRouteContext & { readonly params: { readonly sliceId: string } }
) {
  const slice = await branchCredentialSlice(host, bearerOf(context.request))
  if (!slice || slice.id !== context.params.sliceId) {
    context.set.status = 404
    return { error: "[SixbServer] This branch has no such lake slice." }
  }

  await dropLakeSlice(host, slice.id)
  context.set.status = 204
  return null
}

/** The branch holds its copy whole: its slice lives on. Unconfirmed, it lapses within the hour. */
async function receivedResponse(
  host: SixbHostView,
  context: BranchRouteContext & { readonly params: { readonly sliceId: string } }
) {
  const slice = await credentialSlice(host, context.request)
  if (!slice || slice.id !== context.params.sliceId || !host.storage.lakeSlices) {
    context.set.status = 404
    return { error: "[SixbServer] This branch has no such lake slice. Take a new copy." }
  }

  await host.storage.lakeSlices.markReceived({ projectId: host.id, id: slice.id, at: new Date() })
  context.set.status = 204
  return null
}

const MAX_COPIES_PER_PROJECT = 2
/** The people copying to a branch, per project. */
const copiesRunning = new Map<string, Set<string>>()

/** Null when `branch` names a git branch as a branch's `SIXB_BRANCH` would, else why not. */
function branchName(branch: unknown): string | null {
  try {
    resolveBranchMode({ SIXB_BRANCH: branch as string, SIXB_BRANCH_DATA_FROM: "production" })
    return typeof branch === "string" ? null : "[SixbServer] Name the git branch: { branch }."
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}

function fieldsOf(body: unknown): Record<string, unknown> {
  return typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {}
}
