import {
  type ArtifactAccess,
  type ArtifactContentInput,
  type ArtifactRecord,
  ArtifactRequestError,
  type ArtifactVersionRecord,
  isFileRef,
  type PublishedArtifact,
  type SixbHostView,
} from "@sixb/core"
import {
  AgentExecutionLostError,
  type AgentRunArtifacts,
  agentRunArtifacts,
} from "@sixb/core/internal/agents"
import {
  createArtifactFrame,
  serializeArtifactQueryResult,
} from "@sixb/core/internal/artifacts/frames"
import {
  boardPreview,
  boardPreviewStatuses,
  boardPreviews,
} from "@sixb/core/internal/artifacts/publish"
import type { ArtifactRestorePointRecord, PublishedArtifactVersion } from "@sixb/core/storage"
import type { Elysia } from "elysia"
import { ZodError } from "zod"
import { accessTokenSecurityRequirement } from "../auth/access-token-boundary"
import { requestAuthState, requireRequestSixb } from "../auth/scope"
import {
  createFileContentResponse,
  fileContentGetResponses,
  fileContentHeadResponses,
} from "../files/content"
import { OPENAPI_TAGS } from "../openapi/tags"
import {
  ArtifactBoardPreviewParamsSchema,
  ArtifactBoardPreviewQuerySchema,
  ArtifactChangeResponseSchema,
  ArtifactErrorResponseSchema,
  ArtifactFrameResponseSchema,
  ArtifactListQuerySchema,
  ArtifactListResponseSchema,
  ArtifactParamsSchema,
  ArtifactQueryParamsSchema,
  ArtifactResponseSchema,
  ArtifactRestorePointListResponseSchema,
  ArtifactRestorePointParamsSchema,
  ArtifactRestorePointSchema,
  ArtifactStateParamsSchema,
  ArtifactStateResponseSchema,
  ArtifactVersionParamsSchema,
  ArtifactVersionSchema,
  ClearArtifactStateResponseSchema,
  DeleteArtifactResponseSchema,
  DeleteArtifactStateResponseSchema,
  FreezeArtifactBodySchema,
  PublishArtifactBodySchema,
  PublishedArtifactResponseSchema,
  RestoreArtifactBodySchema,
  SetArtifactStateBodySchema,
  SetArtifactStateResponseSchema,
  UpdateArtifactBodySchema,
} from "../schemas/artifacts"
import { FileContentQuerySchema } from "../schemas/files"
import { handleRouteError, parseOptionalInt, toIsoString } from "../utils/http"
import { handleObjectQueryError } from "./objects"

type RouteSet = { status?: number | string }

// The two below build response bodies; each route parses its whole response once.
function artifactBody(artifact: ArtifactRecord) {
  return {
    id: artifact.id,
    projectId: artifact.projectId,
    kind: artifact.kind,
    title: artifact.title,
    owner: artifact.owner,
    latestVersion: artifact.latestVersion,
    revision: artifact.revision,
    createdAt: toIsoString(artifact.createdAt),
    updatedAt: toIsoString(artifact.updatedAt),
  }
}

function versionBody(version: ArtifactVersionRecord) {
  return {
    artifactId: version.artifactId,
    version: version.version,
    revision: version.revision,
    frozen: version.frozenAt !== undefined,
    title: version.title,
    entry: version.entry,
    files: version.files,
    outline: version.outline,
    references: version.references,
    author: version.author,
    origin: version.origin,
    createdAt: toIsoString(version.createdAt),
    updatedAt: toIsoString(version.updatedAt),
    ...(version.frozenAt ? { frozenAt: toIsoString(version.frozenAt) } : {}),
    ...(version.frozenBy ? { frozenBy: version.frozenBy } : {}),
  }
}

function restorePointSummary(point: ArtifactRestorePointRecord) {
  return {
    artifactId: point.artifactId,
    revision: point.revision,
    version: point.version,
    frozen: point.frozen,
    title: point.title,
    author: point.author,
    origin: point.origin,
    updatedAt: toIsoString(point.updatedAt),
    reason: point.reason,
    ...(point.turnRunId === undefined ? {} : { turnRunId: point.turnRunId }),
    createdAt: toIsoString(point.createdAt),
  }
}

/**
 * A version as one is answered alone, or just written: a canvas's boards say whether their
 * previews are worth waiting for, so a viewer seeded from either asks for them alike.
 */
async function versionResponse(host: SixbHostView, version: ArtifactVersionRecord) {
  const storage = host.storage.artifacts
  const statuses =
    storage && version.outline.kind === "canvas"
      ? await boardPreviewStatuses(storage, version, {
          renders: host.sandboxes !== undefined,
          now: new Date(),
        })
      : undefined

  return {
    ...versionBody(version),
    ...(statuses ? { boardPreviews: Object.fromEntries(statuses) } : {}),
  }
}

async function serializeChange(host: SixbHostView, change: PublishedArtifactVersion) {
  return ArtifactChangeResponseSchema.parse({
    artifact: artifactBody(change.artifact),
    version: await versionResponse(host, change.version),
  })
}

async function serializePublished(host: SixbHostView, published: PublishedArtifact) {
  return PublishedArtifactResponseSchema.parse({
    artifact: artifactBody(published.artifact),
    version: await versionResponse(host, published.version),
    warnings: published.warnings,
  })
}

/** The body's file references narrowed to stored-file references; core checks each one. */
function contentInput(body: {
  readonly kind: ArtifactContentInput["kind"]
  readonly title: string
  readonly files: readonly { readonly path: string; readonly file: unknown }[]
}): ArtifactContentInput {
  return {
    kind: body.kind,
    title: body.title,
    files: body.files.map(({ path, file }) => {
      if (!isFileRef(file)) {
        throw new ArtifactRequestError(
          "invalid_artifact",
          `[SixbServer] '${path}' does not have a valid file reference.`
        )
      }
      return { path, file }
    }),
  }
}

/**
 * What a request with a run token publishes through: its run's conversation, by a run's rules
 * (`AgentRunArtifacts.publish`), as the run's session does in a worker. `null` for any other
 * caller, who publishes as themselves.
 */
async function runTokenArtifacts(
  host: SixbHostView,
  context: unknown
): Promise<AgentRunArtifacts | null> {
  const { agentExecution, sixb } = requestAuthState(context)
  if (!agentExecution) return null
  if (agentExecution.kind === "workflow") {
    throw new ArtifactRequestError(
      "not_allowed",
      "[SixbServer] Workflow agent nodes publish no artifacts: they have no conversation."
    )
  }
  // Fenced with the execution the request was admitted under: a run reclaimed since refuses it.
  const { runId, executionToken } = agentExecution
  const run = await host.storage.agents?.runs.getById({ projectId: host.id, id: runId })
  if (!run || !sixb) throw new AgentExecutionLostError(runId)

  return agentRunArtifacts(
    { projectId: host.id, storage: host.storage, domainEvents: host.events },
    run,
    executionToken,
    () => Promise.resolve(sixb)
  )
}

function versionParam(value: string): number | "latest" {
  return value === "latest" ? "latest" : Number(value)
}

function notFound(set: RouteSet) {
  set.status = 404
  return { error: "Artifact not found", code: "artifact_not_found" as const }
}

/**
 * Why a read found nothing: 404 when there is no such artifact, 403 `not_shared` when there is one
 * the caller cannot read, so a page can say it is not shared in this conversation.
 */
async function refusal(context: unknown, artifactId: string, set: RouteSet) {
  return refusalFor(await requireRequestSixb(context).artifacts.access(artifactId), set)
}

/** Why a restore point was not found: its artifact is not readable, or keeps no such point. */
async function restorePointRefusal(context: unknown, artifactId: string, set: RouteSet) {
  const access = await requireRequestSixb(context).artifacts.access(artifactId)
  if (access === null || access === "none") return refusalFor(access, set)

  set.status = 404
  return { error: "Restore point not found", code: "restore_point_not_found" as const }
}

/** The refusal for what the caller may do with an artifact, once that is known. */
function refusalFor(access: ArtifactAccess | null, set: RouteSet) {
  if (access !== "none") return notFound(set)

  set.status = 403
  return {
    error: "Artifact not shared in a conversation you read",
    code: "not_shared" as const,
  }
}

function handleArtifactRouteError(error: unknown, set: RouteSet) {
  if (error instanceof ArtifactRequestError) {
    switch (error.code) {
      case "artifact_not_found":
      case "query_not_found":
      case "restore_point_not_found":
        set.status = 404
        break
      case "artifact_kind_mismatch":
      case "artifact_moved":
      case "query_invalid":
        set.status = 409
        break
      case "invalid_artifact":
      case "invalid_state":
        set.status = 400
        break
      case "state_full":
        set.status = 413
        break
      case "not_allowed":
      case "not_shared":
      case "read_only":
        set.status = 403
        break
      case "storage_unavailable":
        set.status = 501
        break
    }
    return {
      error: error.message,
      code: error.code,
      ...(error.latest ? { latest: error.latest } : {}),
    }
  }
  if (error instanceof AgentExecutionLostError) {
    set.status = 409
    return {
      error: "[SixbServer] The run has ended or moved to another runner, so nothing was published.",
      code: "execution_lost",
    }
  }
  if (error instanceof ZodError) {
    set.status = 400
    return { error: "Invalid artifact request" }
  }
  return handleRouteError(error, set)
}

/** The artifact error body, for a route that declares its responses in OpenAPI. */
function artifactErrorResponse(status: number) {
  return {
    description: `Response for status ${status}`,
    content: {
      "application/json": { schema: { $ref: "#/components/schemas/ArtifactErrorResponse" } },
    },
  }
}

const writeRefusals = {
  400: ArtifactErrorResponseSchema,
  403: ArtifactErrorResponseSchema,
  404: ArtifactErrorResponseSchema,
  409: ArtifactErrorResponseSchema,
  501: ArtifactErrorResponseSchema,
}

const createResponses = { 201: PublishedArtifactResponseSchema, ...writeRefusals }

const updateResponses = { 200: PublishedArtifactResponseSchema, ...writeRefusals }

async function artifactFileContentResponse(
  host: SixbHostView,
  context: {
    readonly params: { readonly artifactId: string; readonly version: string }
    readonly query: unknown
    readonly request: Request
    readonly set: RouteSet
  },
  options: { readonly head?: boolean } = {}
) {
  try {
    const query = FileContentQuerySchema.parse(context.query)
    const version = await requireRequestSixb(context).artifacts.getVersion(
      context.params.artifactId,
      versionParam(context.params.version)
    )
    if (!version) return await refusal(context, context.params.artifactId, context.set)

    const file = version.files.find((candidate) => candidate.path === query.path)
    const response =
      file &&
      (await createFileContentResponse({
        blobStorage: host.blobStorage,
        fileRef: file.file,
        disposition: query.disposition,
        head: options.head,
        request: context.request,
      }))
    if (!response) {
      context.set.status = 404
      return { error: "File not found" }
    }
    return response
  } catch (error) {
    if (error instanceof ZodError) {
      context.set.status = 400
      return { error: "Invalid file content query" }
    }
    return handleArtifactRouteError(error, context.set)
  }
}

/** A file of a restore point, to whoever reads its artifact. */
async function restorePointFileContentResponse(
  host: SixbHostView,
  context: {
    readonly params: { readonly artifactId: string; readonly revision: string }
    readonly query: unknown
    readonly request: Request
    readonly set: RouteSet
  }
) {
  try {
    const query = FileContentQuerySchema.parse(context.query)
    const { artifactId } = context.params
    const point = await requireRequestSixb(context).artifacts.getRestorePoint(
      artifactId,
      Number(context.params.revision)
    )
    if (!point) return await restorePointRefusal(context, artifactId, context.set)

    const file = point.files.find((candidate) => candidate.path === query.path)
    const response =
      file &&
      (await createFileContentResponse({
        blobStorage: host.blobStorage,
        fileRef: file.file,
        disposition: query.disposition,
        request: context.request,
      }))
    if (!response) {
      context.set.status = 404
      return { error: "File not found" }
    }
    return response
  } catch (error) {
    if (error instanceof ZodError) {
      context.set.status = 400
      return { error: "Invalid file content query" }
    }
    return handleArtifactRouteError(error, context.set)
  }
}

/**
 * A board's preview, to whoever reads its version: reading the version as the caller is the
 * check. Its render key names what the board shows, so a frozen version's preview never changes.
 */
async function artifactBoardPreviewResponse(
  host: SixbHostView,
  context: {
    readonly params: {
      readonly artifactId: string
      readonly version: string
      readonly board: string
    }
    readonly query: unknown
    readonly request: Request
    readonly set: RouteSet & { headers: Record<string, string | number> }
  }
) {
  try {
    const query = ArtifactBoardPreviewQuerySchema.parse(context.query)
    const { artifactId, board } = context.params
    const number = versionParam(context.params.version)

    const version = await requireRequestSixb(context).artifacts.getVersion(artifactId, number)
    if (!version) return await refusal(context, artifactId, context.set)

    // A picture of a revision the version moved past is not this one's.
    const current = query.revision === undefined || query.revision === version.revision

    // The reader's mode, unless the canvas pins another.
    const themes = version.outline.kind === "canvas" ? (version.outline.themes ?? []) : []
    const theme = query.theme && themes.includes(query.theme) ? query.theme : themes[0]

    const storage = host.storage.artifacts
    const preview =
      storage && theme && current
        ? boardPreview(
            (await boardPreviews(storage, version)).get(board),
            theme,
            query.size ?? "full"
          )
        : undefined
    const response =
      preview &&
      (await createFileContentResponse({
        blobStorage: host.blobStorage,
        fileRef: preview.file,
        request: context.request,
      }))
    if (!response) {
      context.set.status = 404
      // It may be rendered in a moment: nothing may keep this answer.
      context.set.headers["cache-control"] = "no-store"
      return { error: "Board preview not found", code: "preview_not_found" as const }
    }

    // A frozen version never changes, nor its boards' pictures, and neither does a revision; an
    // open version asked for without one does at each write.
    response.headers.set(
      "cache-control",
      (number !== "latest" && version.frozenAt) || query.revision !== undefined
        ? "private, max-age=31536000, immutable"
        : "private, no-cache"
    )
    return response
  } catch (error) {
    return handleArtifactRouteError(error, context.set)
  }
}

export function registerArtifactRoutes(app: Elysia, host: SixbHostView) {
  return app
    .get(
      "/api/artifacts",
      async (context) => {
        try {
          const query = ArtifactListQuerySchema.parse(context.query)
          const limit = parseOptionalInt(query.limit)
          const offset = parseOptionalInt(query.offset)
          const result = await requireRequestSixb(context).artifacts.list({
            ...(query.thread === undefined ? {} : { threadId: query.thread }),
            ...(query.kind === undefined ? {} : { kind: query.kind }),
            ...(limit === undefined ? {} : { limit }),
            ...(offset === undefined ? {} : { offset }),
          })
          return ArtifactListResponseSchema.parse({
            artifacts: result.artifacts.map(artifactBody),
            hasMore: result.hasMore,
            total: result.total,
          })
        } catch (error) {
          return handleArtifactRouteError(error, context.set)
        }
      },
      {
        query: ArtifactListQuerySchema,
        response: {
          200: ArtifactListResponseSchema,
          400: ArtifactErrorResponseSchema,
          501: ArtifactErrorResponseSchema,
        },
        detail: {
          summary: "List artifacts",
          description:
            "The caller's artifacts, most recently updated first. With thread, every artifact the conversation shares, for whoever reads it.",
          tags: [OPENAPI_TAGS.artifacts.name],
          operationId: "listArtifacts",
          security: accessTokenSecurityRequirement("listArtifacts"),
        },
      }
    )
    .post(
      "/api/artifacts",
      async (context) => {
        try {
          const body = PublishArtifactBodySchema.parse(context.body)
          const run = await runTokenArtifacts(host, context)
          const published = run
            ? await run.publish(contentInput(body))
            : await requireRequestSixb(context).artifacts.create(contentInput(body))
          context.set.status = 201
          return await serializePublished(host, published)
        } catch (error) {
          return handleArtifactRouteError(error, context.set)
        }
      },
      {
        body: PublishArtifactBodySchema,
        response: createResponses,
        detail: {
          summary: "Create an artifact",
          description:
            "Creates an artifact owned by the caller, with its first version. Store each file with POST /api/files first. With a run token, it is created in the run's conversation, owned by the conversation's owner and authored by the run's requester.",
          tags: [OPENAPI_TAGS.artifacts.name],
          operationId: "createArtifact",
          security: accessTokenSecurityRequirement("createArtifact"),
        },
      }
    )
    .get(
      "/api/artifacts/:artifactId",
      async (context) => {
        try {
          const { artifactId } = context.params
          // What the caller may do is decided once; the reads after it need no second decision.
          const access = await requireRequestSixb(context).artifacts.access(artifactId)
          const storage = host.storage.artifacts
          if (!storage || access === null || access === "none") {
            return refusalFor(access, context.set)
          }

          const at = { projectId: host.id, id: artifactId }
          const [artifact, versions] = await Promise.all([
            storage.get(at),
            storage.listVersions({ projectId: host.id, artifactId }),
          ])
          // Deleted since the decision.
          if (!artifact) return notFound(context.set)

          return ArtifactResponseSchema.parse({
            artifact: artifactBody(artifact),
            versions: versions.versions.map(versionBody),
            access,
          })
        } catch (error) {
          return handleArtifactRouteError(error, context.set)
        }
      },
      {
        params: ArtifactParamsSchema,
        response: {
          200: ArtifactResponseSchema,
          403: ArtifactErrorResponseSchema,
          404: ArtifactErrorResponseSchema,
          501: ArtifactErrorResponseSchema,
        },
        detail: {
          summary: "Get an artifact and its versions",
          tags: [OPENAPI_TAGS.artifacts.name],
          operationId: "getArtifact",
          security: accessTokenSecurityRequirement("getArtifact"),
        },
      }
    )
    .delete(
      "/api/artifacts/:artifactId",
      async (context) => {
        try {
          const artifacts = requireRequestSixb(context).artifacts
          const { artifactId } = context.params
          if (await artifacts.delete(artifactId)) {
            return DeleteArtifactResponseSchema.parse({ deleted: true })
          }

          // Only its owner deletes it, from every conversation that shares it.
          const access = await artifacts.access(artifactId)
          if (access === "update" || access === "read") {
            context.set.status = 403
            return {
              error: "Only the artifact's owner can delete it",
              code: "not_allowed" as const,
            }
          }
          return await refusal(context, artifactId, context.set)
        } catch (error) {
          return handleArtifactRouteError(error, context.set)
        }
      },
      {
        params: ArtifactParamsSchema,
        response: {
          200: DeleteArtifactResponseSchema,
          403: ArtifactErrorResponseSchema,
          404: ArtifactErrorResponseSchema,
          501: ArtifactErrorResponseSchema,
        },
        detail: {
          summary: "Delete an artifact",
          description:
            "Deletes the artifact with every version, from every conversation that shares it. Only its owner can.",
          tags: [OPENAPI_TAGS.artifacts.name],
          operationId: "deleteArtifact",
          security: accessTokenSecurityRequirement("deleteArtifact"),
        },
      }
    )
    .get(
      "/api/artifacts/:artifactId/state",
      async (context) => {
        try {
          const entries = await requireRequestSixb(context)
            .artifacts.state(context.params.artifactId)
            .entries()
          return ArtifactStateResponseSchema.parse({
            entries: entries.map((entry) => ({
              ...entry,
              updatedAt: toIsoString(entry.updatedAt),
            })),
          })
        } catch (error) {
          return handleArtifactRouteError(error, context.set)
        }
      },
      {
        params: ArtifactParamsSchema,
        response: {
          200: ArtifactStateResponseSchema,
          403: ArtifactErrorResponseSchema,
          404: ArtifactErrorResponseSchema,
          501: ArtifactErrorResponseSchema,
        },
        detail: {
          summary: "Read what a page keeps",
          description:
            "Every value the artifact keeps for the caller as its reader, as a page keeps it with sixb.state, across its versions.",
          tags: [OPENAPI_TAGS.artifacts.name],
          operationId: "getArtifactState",
          security: accessTokenSecurityRequirement("getArtifactState"),
        },
      }
    )
    .put(
      "/api/artifacts/:artifactId/state/:key",
      async (context) => {
        try {
          const body = SetArtifactStateBodySchema.parse(context.body)
          const entry = await requireRequestSixb(context)
            .artifacts.state(context.params.artifactId)
            .set(context.params.key, body.value)
          return SetArtifactStateResponseSchema.parse({
            ...entry,
            updatedAt: toIsoString(entry.updatedAt),
          })
        } catch (error) {
          return handleArtifactRouteError(error, context.set)
        }
      },
      {
        params: ArtifactStateParamsSchema,
        body: SetArtifactStateBodySchema,
        response: {
          200: SetArtifactStateResponseSchema,
          400: ArtifactErrorResponseSchema,
          403: ArtifactErrorResponseSchema,
          404: ArtifactErrorResponseSchema,
          413: ArtifactErrorResponseSchema,
          501: ArtifactErrorResponseSchema,
        },
        detail: {
          summary: "Keep a value for a page",
          description:
            "Keeps a JSON value under the key for the caller, replacing one there. Refused with 413 state_full past the limits.",
          tags: [OPENAPI_TAGS.artifacts.name],
          operationId: "setArtifactState",
          security: accessTokenSecurityRequirement("setArtifactState"),
        },
      }
    )
    .delete(
      "/api/artifacts/:artifactId/state/:key",
      async (context) => {
        try {
          const deleted = await requireRequestSixb(context)
            .artifacts.state(context.params.artifactId)
            .delete(context.params.key)
          return DeleteArtifactStateResponseSchema.parse({ deleted })
        } catch (error) {
          return handleArtifactRouteError(error, context.set)
        }
      },
      {
        params: ArtifactStateParamsSchema,
        response: {
          200: DeleteArtifactStateResponseSchema,
          400: ArtifactErrorResponseSchema,
          403: ArtifactErrorResponseSchema,
          404: ArtifactErrorResponseSchema,
          501: ArtifactErrorResponseSchema,
        },
        detail: {
          summary: "Delete a value a page keeps",
          tags: [OPENAPI_TAGS.artifacts.name],
          operationId: "deleteArtifactStateValue",
          security: accessTokenSecurityRequirement("deleteArtifactStateValue"),
        },
      }
    )
    .delete(
      "/api/artifacts/:artifactId/state",
      async (context) => {
        try {
          const cleared = await requireRequestSixb(context)
            .artifacts.state(context.params.artifactId)
            .clear()
          return ClearArtifactStateResponseSchema.parse({ cleared })
        } catch (error) {
          return handleArtifactRouteError(error, context.set)
        }
      },
      {
        params: ArtifactParamsSchema,
        response: {
          200: ClearArtifactStateResponseSchema,
          403: ArtifactErrorResponseSchema,
          404: ArtifactErrorResponseSchema,
          501: ArtifactErrorResponseSchema,
        },
        detail: {
          summary: "Reset what a page keeps",
          description: "Deletes every value the artifact keeps for the caller.",
          tags: [OPENAPI_TAGS.artifacts.name],
          operationId: "clearArtifactState",
          security: accessTokenSecurityRequirement("clearArtifactState"),
        },
      }
    )
    .put(
      "/api/artifacts/:artifactId/content",
      async (context) => {
        try {
          const body = UpdateArtifactBodySchema.parse(context.body)
          const { artifactId } = context.params
          const content = {
            ...contentInput(body),
            ...(body.baseRevision === undefined ? {} : { baseRevision: body.baseRevision }),
          }
          const run = await runTokenArtifacts(host, context)
          const published = run
            ? await run.publish({ ...content, artifactId })
            : await requireRequestSixb(context).artifacts.update(artifactId, content)
          return await serializePublished(host, published)
        } catch (error) {
          return handleArtifactRouteError(error, context.set)
        }
      },
      {
        params: ArtifactParamsSchema,
        body: UpdateArtifactBodySchema,
        response: updateResponses,
        detail: {
          summary: "Update an artifact",
          description:
            "Writes the artifact's latest version: its content is replaced while the version is open, and the next version opens when it is frozen. Either way the revision grows. The kind must be the artifact's. With baseRevision, it is refused with 409 artifact_moved when the artifact changed since. With a run token, only an artifact the run's conversation shares or its requester owns; it is shared in that conversation, and the turn's first write to it keeps a restore point. A run that lost its execution gets 409 execution_lost.",
          tags: [OPENAPI_TAGS.artifacts.name],
          operationId: "updateArtifact",
          security: accessTokenSecurityRequirement("updateArtifact"),
        },
      }
    )
    .post(
      "/api/artifacts/:artifactId/freeze",
      async (context) => {
        try {
          const body = FreezeArtifactBodySchema.parse(context.body ?? {})
          const frozen = await requireRequestSixb(context).artifacts.freeze(
            context.params.artifactId,
            body.baseRevision === undefined ? {} : { baseRevision: body.baseRevision }
          )
          return await serializeChange(host, frozen)
        } catch (error) {
          return handleArtifactRouteError(error, context.set)
        }
      },
      {
        params: ArtifactParamsSchema,
        body: FreezeArtifactBodySchema,
        response: {
          200: ArtifactChangeResponseSchema,
          400: ArtifactErrorResponseSchema,
          403: ArtifactErrorResponseSchema,
          404: ArtifactErrorResponseSchema,
          409: ArtifactErrorResponseSchema,
          501: ArtifactErrorResponseSchema,
        },
        detail: {
          summary: "Create a version",
          description:
            "Freezes the artifact's open latest version: it never changes again, and the next write opens the next version. A latest version already frozen is returned as it is. Whoever may update the artifact may create a version. With baseRevision, it is refused with 409 artifact_moved when the open version changed since.",
          tags: [OPENAPI_TAGS.artifacts.name],
          operationId: "freezeArtifactVersion",
          security: accessTokenSecurityRequirement("freezeArtifactVersion"),
        },
      }
    )
    .get(
      "/api/artifacts/:artifactId/restore-points",
      async (context) => {
        try {
          const { artifactId } = context.params
          const points = await requireRequestSixb(context).artifacts.listRestorePoints(artifactId)
          if (!points) return await refusal(context, artifactId, context.set)

          return ArtifactRestorePointListResponseSchema.parse({
            restorePoints: points.map(restorePointSummary),
          })
        } catch (error) {
          return handleArtifactRouteError(error, context.set)
        }
      },
      {
        params: ArtifactParamsSchema,
        response: {
          200: ArtifactRestorePointListResponseSchema,
          403: ArtifactErrorResponseSchema,
          404: ArtifactErrorResponseSchema,
          501: ArtifactErrorResponseSchema,
        },
        detail: {
          summary: "List an artifact's restore points",
          description:
            "What the artifact's latest version held before each Agent turn's first write to it, and before each restore, newest first. They are not versions: restoring one puts its content back in the latest version.",
          tags: [OPENAPI_TAGS.artifacts.name],
          operationId: "listArtifactRestorePoints",
          security: accessTokenSecurityRequirement("listArtifactRestorePoints"),
        },
      }
    )
    .get(
      "/api/artifacts/:artifactId/restore-points/:revision",
      async (context) => {
        try {
          const { artifactId, revision } = context.params
          const point = await requireRequestSixb(context).artifacts.getRestorePoint(
            artifactId,
            Number(revision)
          )
          if (!point) return await restorePointRefusal(context, artifactId, context.set)

          return ArtifactRestorePointSchema.parse({
            ...restorePointSummary(point),
            entry: point.entry,
            files: point.files,
            outline: point.outline,
            references: point.references,
          })
        } catch (error) {
          return handleArtifactRouteError(error, context.set)
        }
      },
      {
        params: ArtifactRestorePointParamsSchema,
        response: {
          200: ArtifactRestorePointSchema,
          403: ArtifactErrorResponseSchema,
          404: ArtifactErrorResponseSchema,
          501: ArtifactErrorResponseSchema,
        },
        detail: {
          summary: "Get an artifact's restore point",
          description:
            "Its files, outline, and references, as the latest version held them. Read a file's bytes with GET /api/artifacts/{artifactId}/restore-points/{revision}/content.",
          tags: [OPENAPI_TAGS.artifacts.name],
          operationId: "getArtifactRestorePoint",
          security: accessTokenSecurityRequirement("getArtifactRestorePoint"),
        },
      }
    )
    .get(
      "/api/artifacts/:artifactId/restore-points/:revision/content",
      async (context) => restorePointFileContentResponse(host, context),
      {
        params: ArtifactRestorePointParamsSchema,
        query: FileContentQuerySchema,
        detail: {
          summary: "Get a file of an artifact's restore point",
          tags: [OPENAPI_TAGS.artifacts.name],
          operationId: "getArtifactRestorePointFileContent",
          security: accessTokenSecurityRequirement("getArtifactRestorePointFileContent"),
          responses: fileContentGetResponses({ optionalStorage: true }),
        },
      }
    )
    .post(
      "/api/artifacts/:artifactId/restore-points/:revision/restore",
      async (context) => {
        try {
          const body = RestoreArtifactBodySchema.parse(context.body ?? {})
          const { artifactId, revision } = context.params
          const restored = await requireRequestSixb(context).artifacts.restore(
            artifactId,
            Number(revision),
            body.baseRevision === undefined ? {} : { baseRevision: body.baseRevision }
          )
          return await serializeChange(host, restored)
        } catch (error) {
          return handleArtifactRouteError(error, context.set)
        }
      },
      {
        params: ArtifactRestorePointParamsSchema,
        body: RestoreArtifactBodySchema,
        response: {
          200: ArtifactChangeResponseSchema,
          400: ArtifactErrorResponseSchema,
          403: ArtifactErrorResponseSchema,
          404: ArtifactErrorResponseSchema,
          409: ArtifactErrorResponseSchema,
          501: ArtifactErrorResponseSchema,
        },
        detail: {
          summary: "Restore an artifact",
          description:
            "Puts a restore point's content back in the latest version, as an update writes it: in place while it is open, as the next version when it is frozen. What it replaces becomes a restore point, so the restore can be undone. Whoever may update the artifact may restore it. With baseRevision, it is refused with 409 artifact_moved when the artifact changed since.",
          tags: [OPENAPI_TAGS.artifacts.name],
          operationId: "restoreArtifact",
          security: accessTokenSecurityRequirement("restoreArtifact"),
        },
      }
    )
    .post(
      "/api/artifacts/:artifactId/versions/:version/frame",
      async (context) => {
        try {
          const storage = host.storage.artifacts
          // Reading the version as the caller is the check: whoever may read it may frame it, with
          // the files it embeds from artifacts the caller may read too.
          const artifacts = requireRequestSixb(context).artifacts
          const version = await artifacts.getVersion(
            context.params.artifactId,
            versionParam(context.params.version)
          )
          if (!storage) return notFound(context.set)
          if (!version) return await refusal(context, context.params.artifactId, context.set)
          // Any kind but a deck is refused as `artifact_kind_mismatch`.
          const frame = await createArtifactFrame({
            projectId: host.id,
            storage,
            version,
            read: (id, number) => artifacts.getVersion(id, number),
          })
          return ArtifactFrameResponseSchema.parse({
            path: frame.path,
            expiresAt: frame.expiresAt.toISOString(),
          })
        } catch (error) {
          return handleArtifactRouteError(error, context.set)
        }
      },
      {
        params: ArtifactVersionParamsSchema,
        response: {
          200: ArtifactFrameResponseSchema,
          403: ArtifactErrorResponseSchema,
          404: ArtifactErrorResponseSchema,
          409: ArtifactErrorResponseSchema,
          501: ArtifactErrorResponseSchema,
        },
        detail: {
          summary: "Open a version in a frame",
          description:
            "A short-lived path that serves the files of a version that opens in a sandboxed frame, as slides do, at the revision it has now: once the version is written again, the path serves nothing and a new one is needed. It expires within an hour. A kind that does not open in a frame is refused with 409 artifact_kind_mismatch.",
          tags: [OPENAPI_TAGS.artifacts.name],
          operationId: "createArtifactFrame",
          security: accessTokenSecurityRequirement("createArtifactFrame"),
        },
      }
    )
    .get(
      "/api/artifacts/:artifactId/versions/:version",
      async (context) => {
        try {
          const version = await requireRequestSixb(context).artifacts.getVersion(
            context.params.artifactId,
            versionParam(context.params.version)
          )
          if (!version) return await refusal(context, context.params.artifactId, context.set)

          return ArtifactVersionSchema.parse(await versionResponse(host, version))
        } catch (error) {
          return handleArtifactRouteError(error, context.set)
        }
      },
      {
        params: ArtifactVersionParamsSchema,
        response: {
          200: ArtifactVersionSchema,
          403: ArtifactErrorResponseSchema,
          404: ArtifactErrorResponseSchema,
          501: ArtifactErrorResponseSchema,
        },
        detail: {
          summary: "Get an artifact version",
          description: 'Its files, outline, and references. Use "latest" for the newest version.',
          tags: [OPENAPI_TAGS.artifacts.name],
          operationId: "getArtifactVersion",
          security: accessTokenSecurityRequirement("getArtifactVersion"),
        },
      }
    )
    .get(
      "/api/artifacts/:artifactId/versions/:version/boards/:board/preview",
      async (context) => artifactBoardPreviewResponse(host, context),
      {
        params: ArtifactBoardPreviewParamsSchema,
        query: ArtifactBoardPreviewQuerySchema,
        detail: {
          summary: "Get the preview of a canvas's board",
          description:
            "A picture of the board as its version shows it, in the reader's mode: a PNG at its own size, or with size=small a WebP at most 480 pixels wide, which a viewer shows until the board is opened. It shows the data the version's author can see. A frozen version's preview never changes, and is cached as such, as is one asked for at a revision; an open version's otherwise, and \"latest\", are revalidated. 404 preview_not_found until it is rendered, when it never will be, or when revision is not the version's current one: the version says which.",
          tags: [OPENAPI_TAGS.artifacts.name],
          operationId: "getArtifactBoardPreview",
          security: accessTokenSecurityRequirement("getArtifactBoardPreview"),
          responses: {
            200: {
              description: "The board's preview",
              content: {
                "image/png": { schema: { type: "string", format: "binary" } },
                "image/webp": { schema: { type: "string", format: "binary" } },
              },
            },
            304: { description: "The preview is unchanged; reuse the privately cached one" },
            400: artifactErrorResponse(400),
            403: artifactErrorResponse(403),
            404: artifactErrorResponse(404),
            501: artifactErrorResponse(501),
          },
        },
      }
    )
    .get(
      "/api/artifacts/:artifactId/versions/:version/queries/:name",
      async (context) => {
        try {
          const { artifactId, version, name } = context.params
          const result = await requireRequestSixb(context).artifacts.query(artifactId, name, {
            version: versionParam(version),
          })
          if (!result) return await refusal(context, artifactId, context.set)

          // Typed by the ArtifactQueryResponse component, as the query route types its rows.
          return serializeArtifactQueryResult(result)
        } catch (error) {
          // What the query itself runs into answers as the objects API answers it.
          return error instanceof ArtifactRequestError || error instanceof ZodError
            ? handleArtifactRouteError(error, context.set)
            : handleObjectQueryError(error, context.set)
        }
      },
      {
        params: ArtifactQueryParamsSchema,
        detail: {
          summary: "Run an artifact's query",
          description:
            'Runs the version\'s queries/<name>.json as the caller, with their rights: a type they cannot view is refused with 403, and a marked property they are not cleared for is left out of each row. Rows are serialized as POST /api/objects/query returns them, beside the schema of what they hold as the caller may view it. Use "latest" for the newest version. A query the ontology no longer admits is refused with 409 query_invalid.',
          tags: [OPENAPI_TAGS.artifacts.name],
          operationId: "getArtifactQuery",
          security: accessTokenSecurityRequirement("getArtifactQuery"),
          // Declared in OpenAPI, not zod, as the query route declares its own: the rows take the
          // ObjectQueryObject component, so they are typed as that route's rows.
          responses: {
            200: {
              description: "Response for status 200",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/ArtifactQueryResponse" },
                },
              },
            },
            400: {
              description: "Response for status 400",
              content: {
                "application/json": { schema: { $ref: "#/components/schemas/ErrorResponse" } },
              },
            },
            403: artifactErrorResponse(403),
            404: artifactErrorResponse(404),
            409: artifactErrorResponse(409),
            501: artifactErrorResponse(501),
          },
        },
      }
    )
    .get(
      "/api/artifacts/:artifactId/versions/:version/content",
      async (context) => artifactFileContentResponse(host, context),
      {
        params: ArtifactVersionParamsSchema,
        query: FileContentQuerySchema,
        detail: {
          summary: "Get a file of an artifact version",
          tags: [OPENAPI_TAGS.artifacts.name],
          operationId: "getArtifactFileContent",
          security: accessTokenSecurityRequirement("getArtifactFileContent"),
          responses: fileContentGetResponses({ optionalStorage: true }),
        },
      }
    )
    .head(
      "/api/artifacts/:artifactId/versions/:version/content",
      async (context) => artifactFileContentResponse(host, context, { head: true }),
      {
        params: ArtifactVersionParamsSchema,
        query: FileContentQuerySchema,
        detail: {
          summary: "Head a file of an artifact version",
          tags: [OPENAPI_TAGS.artifacts.name],
          operationId: "headArtifactFileContent",
          security: accessTokenSecurityRequirement("headArtifactFileContent"),
          responses: fileContentHeadResponses({ optionalStorage: true }),
        },
      }
    )
}
