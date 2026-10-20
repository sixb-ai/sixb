import {
  type ArtifactContentInput,
  type ArtifactRecord,
  ArtifactRequestError,
  type ArtifactVersionRecord,
  AuthorizationError,
  isFileRef,
  type ListArtifactVersionsResult,
  type PublishedArtifact,
  type SixbHostView,
} from "@sixb/core"
import { createArtifactFrame } from "@sixb/core/internal/artifacts/frames"
import type { Elysia } from "elysia"
import { ZodError } from "zod"
import { accessTokenSecurityRequirement } from "../auth/access-token-boundary"
import { requestCaller, requireRequestSixb } from "../auth/scope"
import {
  createFileContentResponse,
  fileContentGetResponses,
  fileContentHeadResponses,
} from "../files/content"
import { OPENAPI_TAGS } from "../openapi/tags"
import {
  ArtifactErrorResponseSchema,
  ArtifactFrameResponseSchema,
  ArtifactListQuerySchema,
  ArtifactListResponseSchema,
  ArtifactParamsSchema,
  ArtifactResponseSchema,
  ArtifactStateParamsSchema,
  ArtifactStateResponseSchema,
  ArtifactVersionParamsSchema,
  ArtifactVersionSchema,
  ClearArtifactStateResponseSchema,
  DeleteArtifactResponseSchema,
  DeleteArtifactStateResponseSchema,
  PublishArtifactBodySchema,
  PublishArtifactVersionBodySchema,
  PublishedArtifactResponseSchema,
  SetArtifactStateBodySchema,
  SetArtifactStateResponseSchema,
} from "../schemas/artifacts"
import { FileContentQuerySchema } from "../schemas/files"
import { handleRouteError, parseOptionalInt, toIsoString } from "../utils/http"

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
    createdAt: toIsoString(artifact.createdAt),
    updatedAt: toIsoString(artifact.updatedAt),
  }
}

function versionBody(version: ArtifactVersionRecord) {
  return {
    artifactId: version.artifactId,
    version: version.version,
    title: version.title,
    entry: version.entry,
    files: version.files,
    outline: version.outline,
    references: version.references,
    author: version.author,
    origin: version.origin,
    createdAt: toIsoString(version.createdAt),
  }
}

function serializePublished(published: PublishedArtifact) {
  return PublishedArtifactResponseSchema.parse({
    artifact: artifactBody(published.artifact),
    version: versionBody(published.version),
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

/** What the read routes need of an artifact, whoever's it is. */
interface ArtifactReader {
  get(artifactId: string): Promise<ArtifactRecord | null>
  getVersion(artifactId: string, version: number | "latest"): Promise<ArtifactVersionRecord | null>
  listVersions(artifactId: string): Promise<ListArtifactVersionsResult | null>
}

/**
 * The caller's own artifacts first. Failing that, a signed-in session with
 * `can.observe(agent.threads)` reads what the Agent published in a conversation, as the observed
 * thread routes let it; an access token never does. Writes never come here.
 */
function artifactReader(context: unknown): ArtifactReader {
  const sixb = requireRequestSixb(context)
  const own = sixb.artifacts
  const observed =
    requestCaller(context)?.credentialSource === "session" ? sixb.agent.observed.artifacts : null

  // Without the grant, an artifact that is not the caller's stays not found, as it always was.
  const orObserved = async <T>(
    read: (artifacts: NonNullable<typeof observed>) => Promise<T | null>
  ): Promise<T | null> => {
    if (!observed) return null
    try {
      return await read(observed)
    } catch (error) {
      if (error instanceof AuthorizationError) return null
      throw error
    }
  }

  return {
    get: async (artifactId) =>
      (await own.get(artifactId)) ?? orObserved((artifacts) => artifacts.get(artifactId)),
    getVersion: async (artifactId, version) =>
      (await own.getVersion(artifactId, version)) ??
      orObserved((artifacts) => artifacts.getVersion(artifactId, version)),
    listVersions: async (artifactId) =>
      (await own.listVersions(artifactId)) ??
      orObserved((artifacts) => artifacts.listVersions(artifactId)),
  }
}

function versionParam(value: string): number | "latest" {
  return value === "latest" ? "latest" : Number(value)
}

function notFound(set: RouteSet) {
  set.status = 404
  return { error: "Artifact not found", code: "artifact_not_found" as const }
}

function handleArtifactRouteError(error: unknown, set: RouteSet) {
  if (error instanceof ArtifactRequestError) {
    switch (error.code) {
      case "artifact_not_found":
        set.status = 404
        break
      case "artifact_kind_mismatch":
      case "artifact_moved":
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
  if (error instanceof ZodError) {
    set.status = 400
    return { error: "Invalid artifact request" }
  }
  return handleRouteError(error, set)
}

const publishResponses = {
  201: PublishedArtifactResponseSchema,
  400: ArtifactErrorResponseSchema,
  403: ArtifactErrorResponseSchema,
  404: ArtifactErrorResponseSchema,
  409: ArtifactErrorResponseSchema,
  501: ArtifactErrorResponseSchema,
}

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
    const version = await artifactReader(context).getVersion(
      context.params.artifactId,
      versionParam(context.params.version)
    )
    const file = version?.files.find((candidate) => candidate.path === query.path)
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
          description: "The caller's artifacts, most recently updated first.",
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
          const published = await requireRequestSixb(context).artifacts.create(contentInput(body))
          context.set.status = 201
          return serializePublished(published)
        } catch (error) {
          return handleArtifactRouteError(error, context.set)
        }
      },
      {
        body: PublishArtifactBodySchema,
        response: publishResponses,
        detail: {
          summary: "Create an artifact",
          description:
            "Creates an artifact owned by the caller, with its first version. Store each file with POST /api/files first.",
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
          const artifacts = artifactReader(context)
          const artifact = await artifacts.get(context.params.artifactId)
          const versions = artifact && (await artifacts.listVersions(artifact.id))
          if (!artifact || !versions) return notFound(context.set)
          return ArtifactResponseSchema.parse({
            artifact: artifactBody(artifact),
            versions: versions.versions.map(versionBody),
          })
        } catch (error) {
          return handleArtifactRouteError(error, context.set)
        }
      },
      {
        params: ArtifactParamsSchema,
        response: {
          200: ArtifactResponseSchema,
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
          const deleted = await requireRequestSixb(context).artifacts.delete(
            context.params.artifactId
          )
          if (!deleted) return notFound(context.set)
          return DeleteArtifactResponseSchema.parse({ deleted: true })
        } catch (error) {
          return handleArtifactRouteError(error, context.set)
        }
      },
      {
        params: ArtifactParamsSchema,
        response: {
          200: DeleteArtifactResponseSchema,
          404: ArtifactErrorResponseSchema,
          501: ArtifactErrorResponseSchema,
        },
        detail: {
          summary: "Delete an artifact",
          description: "Deletes the artifact with every version.",
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
    .post(
      "/api/artifacts/:artifactId/versions",
      async (context) => {
        try {
          const body = PublishArtifactVersionBodySchema.parse(context.body)
          const published = await requireRequestSixb(context).artifacts.publish(
            context.params.artifactId,
            {
              ...contentInput(body),
              ...(body.baseVersion === undefined ? {} : { baseVersion: body.baseVersion }),
            }
          )
          context.set.status = 201
          return serializePublished(published)
        } catch (error) {
          return handleArtifactRouteError(error, context.set)
        }
      },
      {
        params: ArtifactParamsSchema,
        body: PublishArtifactVersionBodySchema,
        response: publishResponses,
        detail: {
          summary: "Publish an artifact's next version",
          description:
            "The kind must be the artifact's. The new version becomes the latest. With baseVersion, it is refused with 409 artifact_moved when another version was published since.",
          tags: [OPENAPI_TAGS.artifacts.name],
          operationId: "publishArtifactVersion",
          security: accessTokenSecurityRequirement("publishArtifactVersion"),
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
          const artifacts = artifactReader(context)
          const version = await artifacts.getVersion(
            context.params.artifactId,
            versionParam(context.params.version)
          )
          if (!version || !storage) return notFound(context.set)
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
          404: ArtifactErrorResponseSchema,
          409: ArtifactErrorResponseSchema,
          501: ArtifactErrorResponseSchema,
        },
        detail: {
          summary: "Open a version in a frame",
          description:
            "A short-lived path that serves the files of a version that opens in a sandboxed frame, as slides do. It expires within an hour. A kind that does not open in a frame is refused with 409 artifact_kind_mismatch.",
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
          const version = await artifactReader(context).getVersion(
            context.params.artifactId,
            versionParam(context.params.version)
          )
          if (!version) return notFound(context.set)
          return ArtifactVersionSchema.parse(versionBody(version))
        } catch (error) {
          return handleArtifactRouteError(error, context.set)
        }
      },
      {
        params: ArtifactVersionParamsSchema,
        response: {
          200: ArtifactVersionSchema,
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
