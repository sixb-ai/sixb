import {
  type ArtifactContentInput,
  type ArtifactRecord,
  ArtifactRequestError,
  type ArtifactVersionRecord,
  isFileRef,
  type PublishedArtifact,
  type SixbHostView,
} from "@sixb/core"
import { createArtifactFrame } from "@sixb/core/internal/artifacts/frames"
import type { Elysia } from "elysia"
import { ZodError } from "zod"
import { accessTokenSecurityRequirement } from "../auth/access-token-boundary"
import { requireRequestSixb } from "../auth/scope"
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
  ArtifactVersionParamsSchema,
  ArtifactVersionSchema,
  DeleteArtifactResponseSchema,
  PublishArtifactBodySchema,
  PublishArtifactVersionBodySchema,
  PublishedArtifactResponseSchema,
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
        set.status = 400
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
    const version = await requireRequestSixb(context).artifacts.getVersion(
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
          const sixb = requireRequestSixb(context)
          const artifact = await sixb.artifacts.get(context.params.artifactId)
          const versions = artifact && (await sixb.artifacts.listVersions(artifact.id))
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
          const artifacts = requireRequestSixb(context).artifacts
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
          const version = await requireRequestSixb(context).artifacts.getVersion(
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
