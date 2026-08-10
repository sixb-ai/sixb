import {
  type BlobDigest,
  DEFAULT_SIMPLE_FILE_UPLOAD_BYTES,
  type FileRef,
  InMemoryFileUploadSessions,
  type OntologySource,
  type Principal,
  type Sixb,
} from "@sixb/core"
import { computeBlobDigest, supportsDirectUpload } from "@sixb/core/blob-storage/server"
import {
  createFileUploadId,
  createUploadExpiresAt,
  type FileUploadSession,
  FileUploadSessionError,
} from "@sixb/core/storage"
import type { Elysia } from "elysia"
import { bearerSecurityRequirement } from "../auth/access-token-boundary"
import { requestAuthState } from "../auth/scope"
import { SIXB_CSRF_SECURITY_REQUIREMENT } from "../openapi/security"
import { OPENAPI_TAGS } from "../openapi/tags"
import { ErrorResponseSchema, SuccessResponseSchema } from "../schemas/common"
import {
  CompleteFileUploadBodySchema,
  CreateFileUploadBodySchema,
  CreateFileUploadResponseSchema,
  FileRefSchema,
  FileUploadIdParamsSchema,
  FileUploadPartParamsSchema,
  SignedFileUploadPartSchema,
} from "../schemas/files"
import { handleRouteError } from "../utils/http"
import { RequestBodyTooLargeError, readRequestBodyWithLimit } from "../utils/request-body"
// The simple-upload ceiling lives in @sixb/core so the client staged-switch
// threshold and this server limit stay a single source of truth. The body limit
// adds headroom for multipart/form-data encoding overhead on the `POST /api/files`
// form route (it is unrelated to the removed multipart upload strategy).
export const DEFAULT_SIMPLE_FILE_UPLOAD_BODY_BYTES = DEFAULT_SIMPLE_FILE_UPLOAD_BYTES + 1024 * 1024

const SYSTEM_PRINCIPAL: Principal = { type: "system", id: "system" }

export function registerFileRoutes(app: Elysia, sixb: Sixb<readonly OntologySource[]>) {
  // Staged/direct-put upload sessions default to an in-memory store: they are NOT
  // durable across restart and NOT shared across instances. A durable Pg/Sqlite
  // store is a follow-up; deployments needing durability supply their own via
  // `sixb.storage.fileUploadSessions`.
  const uploadSessions = sixb.storage.fileUploadSessions ?? new InMemoryFileUploadSessions()

  return app
    .post(
      "/api/files",
      async ({ request, set }) => {
        try {
          const requestSizeError = requestSizeLimitError(
            request,
            DEFAULT_SIMPLE_FILE_UPLOAD_BODY_BYTES
          )
          if (requestSizeError) {
            set.status = 413
            return { error: requestSizeError }
          }

          const form = await request.formData()
          const file = form.get("file")
          const logicalPath = form.get("logicalPath")

          if (!(file instanceof File)) {
            set.status = 400
            return { error: "Expected multipart field 'file' to be a file." }
          }

          if (logicalPath !== null && typeof logicalPath !== "string") {
            set.status = 400
            return { error: "Expected multipart field 'logicalPath' to be a string." }
          }

          if (file.size > DEFAULT_SIMPLE_FILE_UPLOAD_BYTES) {
            set.status = 413
            return {
              error: `File upload exceeds the ${DEFAULT_SIMPLE_FILE_UPLOAD_BYTES} byte limit.`,
            }
          }

          const fileRef = await sixb.blobs.put({
            body: file,
            fileName: file.name || undefined,
            mediaType: file.type || undefined,
            logicalPath: logicalPath ?? undefined,
          })

          return FileRefSchema.parse(fileRef)
        } catch (error) {
          return handleRouteError(error, set)
        }
      },
      {
        response: {
          200: FileRefSchema,
          400: ErrorResponseSchema,
          413: ErrorResponseSchema,
        },
        detail: {
          summary: "Upload a file",
          tags: [OPENAPI_TAGS.files.name],
          operationId: "uploadFileRaw",
          security: bearerSecurityRequirement("uploadFileRaw"),
          requestBody: {
            required: true,
            content: {
              "multipart/form-data": {
                schema: {
                  type: "object",
                  required: ["file"],
                  properties: {
                    file: {
                      type: "string",
                      format: "binary",
                    },
                    logicalPath: {
                      type: "string",
                    },
                  },
                },
              },
            },
          },
        },
      }
    )
    .post(
      "/api/files/uploads",
      async (context) => {
        const { body, set } = context
        const { authz } = requestAuthState(context)
        try {
          const parsed = CreateFileUploadBodySchema.parse(body)
          const principal = authz?.principal ?? SYSTEM_PRINCIPAL
          const uploadId = createFileUploadId()
          const expiresAt = createUploadExpiresAt()
          const expectedDigest = parsed.digest as BlobDigest | undefined
          const providerUpload =
            supportsDirectUpload(sixb.blobs) &&
            expectedDigest !== undefined &&
            parsed.sizeBytes !== undefined
              ? await sixb.blobs.createUpload({
                  uploadId,
                  expiresAt,
                  ...(parsed.fileName === undefined ? {} : { fileName: parsed.fileName }),
                  ...(parsed.mediaType === undefined ? {} : { mediaType: parsed.mediaType }),
                  ...(parsed.logicalPath === undefined ? {} : { logicalPath: parsed.logicalPath }),
                  ...(parsed.sizeBytes === undefined ? {} : { sizeBytes: parsed.sizeBytes }),
                  expectedDigest,
                })
              : undefined

          const session = await uploadSessions.create({
            id: uploadId,
            projectId: sixb.id,
            principal,
            strategy: providerUpload?.strategy ?? "server",
            expiresAt,
            ...(parsed.fileName === undefined ? {} : { fileName: parsed.fileName }),
            ...(parsed.mediaType === undefined ? {} : { mediaType: parsed.mediaType }),
            ...(parsed.logicalPath === undefined ? {} : { logicalPath: parsed.logicalPath }),
            ...(parsed.sizeBytes === undefined ? {} : { expectedSizeBytes: parsed.sizeBytes }),
            ...(expectedDigest === undefined ? {} : { expectedDigest }),
            ...(providerUpload === undefined ? {} : { providerUpload }),
          })

          set.status = 201
          return CreateFileUploadResponseSchema.parse(fileUploadResponse(session))
        } catch (error) {
          return handleRouteError(error, set)
        }
      },
      {
        body: CreateFileUploadBodySchema,
        response: {
          201: CreateFileUploadResponseSchema,
          400: ErrorResponseSchema,
        },
        detail: {
          summary: "Create a staged file upload",
          tags: [OPENAPI_TAGS.files.name],
          operationId: "createFileUpload",
          security: SIXB_CSRF_SECURITY_REQUIREMENT,
        },
      }
    )
    .put(
      "/api/files/uploads/:uploadId/content",
      async (context) => {
        const { params, request, set } = context
        const { authz } = requestAuthState(context)
        try {
          const principal = authz?.principal ?? SYSTEM_PRINCIPAL
          const session = await uploadSessions.getForPrincipal(params.uploadId, principal)
          if (session.status !== "pending") {
            throw terminalSessionError(session.status)
          }

          if (session.strategy !== "server") {
            set.status = 400
            return { error: "Upload content is only accepted for server staged uploads." }
          }

          const contentLengthSizeError = expectedContentLengthError(session, request)
          if (contentLengthSizeError) {
            set.status = 400
            return { error: contentLengthSizeError }
          }

          const uploadBytes = readParsedUploadBytes(context)
          if (uploadBytes.byteLength === 0) {
            set.status = 400
            return { error: "Expected upload content body." }
          }

          const sizeError = expectedSizeBytesError(session, uploadBytes.byteLength)
          if (sizeError) {
            set.status = 400
            return { error: sizeError }
          }

          const digest = computeBlobDigest(uploadBytes)
          const digestError = expectedDigestError(session.expectedDigest, digest)
          if (digestError) {
            set.status = 400
            return { error: digestError }
          }

          const fileRef = await sixb.blobs.put({
            body: uploadBytes,
            ...(session.fileName === undefined ? {} : { fileName: session.fileName }),
            ...(session.mediaType === undefined ? {} : { mediaType: session.mediaType }),
            ...(session.logicalPath === undefined ? {} : { logicalPath: session.logicalPath }),
          })

          await uploadSessions.markUploaded(session.id, fileRef)
          return { success: true }
        } catch (error) {
          return handleRouteError(error, set)
        }
      },
      {
        params: FileUploadIdParamsSchema,
        // Replace Elysia's default body parser so the octet-stream is read through
        // the size-capped streaming reader instead of being fully buffered first.
        parse: readCappedUploadBody,
        // The cap is enforced during parsing, which is outside the handler's
        // try/catch, so map its too-large error to 413 here.
        error: mapUploadContentError,
        response: {
          200: SuccessResponseSchema,
          400: ErrorResponseSchema,
          404: ErrorResponseSchema,
          409: ErrorResponseSchema,
          410: ErrorResponseSchema,
        },
        detail: {
          summary: "Upload staged file content through Sixb",
          tags: [OPENAPI_TAGS.files.name],
          operationId: "uploadFileContent",
          security: SIXB_CSRF_SECURITY_REQUIREMENT,
          requestBody: {
            required: true,
            content: {
              "application/octet-stream": {
                schema: {
                  type: "string",
                  format: "binary",
                },
              },
            },
          },
        },
      }
    )
    .post(
      "/api/files/uploads/:uploadId/parts/:partNumber",
      async (context) => {
        const { params, set } = context
        const { authz } = requestAuthState(context)
        try {
          const principal = authz?.principal ?? SYSTEM_PRINCIPAL
          const session = await uploadSessions.getForPrincipal(params.uploadId, principal)
          if (session.status !== "pending") {
            throw terminalSessionError(session.status)
          }

          if (
            session.strategy !== "multipart" ||
            session.providerUpload?.strategy !== "multipart"
          ) {
            set.status = 400
            return { error: "Upload session does not use multipart strategy." }
          }

          if (!supportsDirectUpload(sixb.blobs)) {
            set.status = 400
            return { error: "Blob storage does not support direct uploads." }
          }

          const signedPart = await sixb.blobs.signUploadPart({
            uploadId: session.id,
            stagingKey: session.providerUpload.stagingKey,
            providerUploadId: session.providerUpload.providerUploadId,
            partNumber: Number.parseInt(params.partNumber, 10),
            expiresAt: session.expiresAt,
          })
          await uploadSessions.addSignedPart(session.id, signedPart)

          return SignedFileUploadPartSchema.parse({
            ...signedPart,
            expiresAt: signedPart.expiresAt.toISOString(),
          })
        } catch (error) {
          return handleRouteError(error, set)
        }
      },
      {
        params: FileUploadPartParamsSchema,
        response: {
          200: SignedFileUploadPartSchema,
          400: ErrorResponseSchema,
          404: ErrorResponseSchema,
          409: ErrorResponseSchema,
          410: ErrorResponseSchema,
        },
        detail: {
          summary: "Sign a staged multipart upload part",
          tags: [OPENAPI_TAGS.files.name],
          operationId: "signFileUploadPart",
          security: SIXB_CSRF_SECURITY_REQUIREMENT,
        },
      }
    )
    .post(
      "/api/files/uploads/:uploadId/complete",
      async (context) => {
        const { body, params, set } = context
        const { authz } = requestAuthState(context)
        try {
          const principal = authz?.principal ?? SYSTEM_PRINCIPAL
          const parsed = CompleteFileUploadBodySchema.parse(body ?? {})
          const session = await uploadSessions.getForPrincipal(params.uploadId, principal)

          if (session.status === "completed" && session.fileRef) {
            return FileRefSchema.parse(session.fileRef)
          }

          if (session.status !== "pending") {
            throw terminalSessionError(session.status)
          }

          const expected = resolveExpectedUploadIdentity({
            session,
            requestedDigest: parsed.digest as BlobDigest | undefined,
            requestedSizeBytes: parsed.sizeBytes,
          })
          if (
            session.strategy !== "server" &&
            (expected.digest === undefined || expected.sizeBytes === undefined)
          ) {
            throw new Error("Direct file uploads require an expected digest and size.")
          }

          const fileRef =
            session.strategy === "server"
              ? completeServerUpload(session)
              : await completeProviderUpload({
                  session,
                  expectedDigest: expected.digest,
                  expectedSizeBytes: expected.sizeBytes,
                  parts: parsed.parts,
                  blobStorage: sixb.blobs,
                })

          const identityError = expectedFileRefError(expected, fileRef)
          if (identityError) {
            throw new Error(identityError)
          }

          await uploadSessions.complete(session.id, fileRef)
          return FileRefSchema.parse(fileRef)
        } catch (error) {
          return handleRouteError(error, set)
        }
      },
      {
        params: FileUploadIdParamsSchema,
        body: CompleteFileUploadBodySchema,
        response: {
          200: FileRefSchema,
          400: ErrorResponseSchema,
          404: ErrorResponseSchema,
          409: ErrorResponseSchema,
          410: ErrorResponseSchema,
        },
        detail: {
          summary: "Complete a staged file upload",
          tags: [OPENAPI_TAGS.files.name],
          operationId: "completeFileUpload",
          security: SIXB_CSRF_SECURITY_REQUIREMENT,
        },
      }
    )
    .post(
      "/api/files/uploads/:uploadId/abort",
      async (context) => {
        const { params, set } = context
        const { authz } = requestAuthState(context)
        try {
          const principal = authz?.principal ?? SYSTEM_PRINCIPAL
          const session = await uploadSessions.getForPrincipal(params.uploadId, principal)

          if (session.status === "completed") {
            throw new FileUploadSessionError(
              "already_completed",
              "File upload session is already completed."
            )
          }

          if (session.status === "pending" && session.providerUpload) {
            if (!supportsDirectUpload(sixb.blobs)) {
              set.status = 400
              return { error: "Blob storage does not support direct uploads." }
            }

            await sixb.blobs.abortUpload({
              uploadId: session.id,
              stagingKey: session.providerUpload.stagingKey,
              providerUploadId: session.providerUpload.providerUploadId,
            })
          }

          if (session.status === "pending") {
            await uploadSessions.abort(session.id)
          }

          return { success: true }
        } catch (error) {
          return handleRouteError(error, set)
        }
      },
      {
        params: FileUploadIdParamsSchema,
        response: {
          200: SuccessResponseSchema,
          400: ErrorResponseSchema,
          404: ErrorResponseSchema,
          409: ErrorResponseSchema,
          410: ErrorResponseSchema,
        },
        detail: {
          summary: "Abort a staged file upload",
          tags: [OPENAPI_TAGS.files.name],
          operationId: "abortFileUpload",
          security: SIXB_CSRF_SECURITY_REQUIREMENT,
        },
      }
    )
}

function fileUploadResponse(session: FileUploadSession) {
  if (session.providerUpload?.strategy === "direct-put") {
    return {
      strategy: "direct-put",
      uploadId: session.id,
      method: session.providerUpload.method,
      url: session.providerUpload.url,
      headers: session.providerUpload.headers,
      expiresAt: session.providerUpload.expiresAt.toISOString(),
    }
  }

  if (session.providerUpload?.strategy === "multipart") {
    return {
      strategy: "multipart",
      uploadId: session.id,
      partSizeBytes: session.providerUpload.partSizeBytes,
      expiresAt: session.providerUpload.expiresAt.toISOString(),
    }
  }

  return {
    strategy: "server",
    uploadId: session.id,
    method: "PUT",
    url: `/api/files/uploads/${encodeURIComponent(session.id)}/content`,
    expiresAt: session.expiresAt.toISOString(),
  }
}

// Elysia `parse` hook: reads the staged content stream with a hard size ceiling,
// so an oversized (or chunked, content-length-lying) body is rejected before it
// is fully buffered. Its result becomes `context.body`.
function readCappedUploadBody(context: { request: Request }): Promise<Uint8Array> {
  return readRequestBodyWithLimit(context.request, DEFAULT_SIMPLE_FILE_UPLOAD_BYTES)
}

function readParsedUploadBytes(context: { body?: unknown }): Uint8Array {
  return context.body instanceof Uint8Array ? context.body : new Uint8Array(0)
}

function mapUploadContentError(context: {
  error: unknown
  set: { status?: number | string }
}): { error: string } | undefined {
  const tooLarge = asRequestBodyTooLarge(context.error)
  if (tooLarge) {
    context.set.status = 413
    return { error: tooLarge.message }
  }
  return undefined
}

// The cap runs in the `parse` phase, so Elysia surfaces it wrapped in a
// ParseError; the original error is carried on `cause`.
function asRequestBodyTooLarge(error: unknown): RequestBodyTooLargeError | undefined {
  if (error instanceof RequestBodyTooLargeError) {
    return error
  }
  const cause = (error as { cause?: unknown } | null | undefined)?.cause
  return cause instanceof RequestBodyTooLargeError ? cause : undefined
}

// A non-pending session is terminal; surface which terminal state so the route
// boundary maps it to 409. Store lookups already raise `not_found`/`expired`.
function terminalSessionError(status: "completed" | "aborted"): FileUploadSessionError {
  return new FileUploadSessionError(
    status === "completed" ? "already_completed" : "already_aborted",
    `File upload session is already ${status}.`
  )
}

function completeServerUpload(session: FileUploadSession): FileRef {
  if (!session.fileRef) {
    throw new Error("Upload content has not been received.")
  }

  return session.fileRef
}

async function completeProviderUpload(input: {
  readonly session: FileUploadSession
  readonly expectedDigest?: BlobDigest
  readonly expectedSizeBytes?: number
  readonly parts: readonly { readonly partNumber: number; readonly etag: string }[] | undefined
  readonly blobStorage: Sixb<readonly OntologySource[]>["blobs"]
}): Promise<FileRef> {
  const { blobStorage, session } = input
  if (!session.providerUpload) {
    throw new Error("Upload session does not have provider upload state.")
  }

  if (!supportsDirectUpload(blobStorage)) {
    throw new Error("Blob storage does not support direct uploads.")
  }

  const fileRef = await blobStorage.completeUpload({
    uploadId: session.id,
    stagingKey: session.providerUpload.stagingKey,
    providerUploadId: session.providerUpload.providerUploadId,
    ...(session.fileName === undefined ? {} : { fileName: session.fileName }),
    ...(session.mediaType === undefined ? {} : { mediaType: session.mediaType }),
    ...(session.logicalPath === undefined ? {} : { logicalPath: session.logicalPath }),
    ...(input.expectedSizeBytes === undefined
      ? {}
      : { expectedSizeBytes: input.expectedSizeBytes }),
    ...(input.expectedDigest === undefined ? {} : { expectedDigest: input.expectedDigest }),
    ...(input.parts === undefined ? {} : { parts: input.parts }),
  })

  return fileRef
}

interface ExpectedUploadIdentity {
  readonly digest?: BlobDigest
  readonly sizeBytes?: number
}

function resolveExpectedUploadIdentity(input: {
  readonly session: FileUploadSession
  readonly requestedDigest?: BlobDigest
  readonly requestedSizeBytes?: number
}): ExpectedUploadIdentity {
  const digestError = expectedDigestError(input.session.expectedDigest, input.requestedDigest)
  if (digestError) {
    throw new Error(digestError)
  }

  const sizeError = expectedSizeBytesValueError(
    input.session.expectedSizeBytes,
    input.requestedSizeBytes
  )
  if (sizeError) {
    throw new Error(sizeError)
  }

  const digest = input.session.expectedDigest ?? input.requestedDigest
  const sizeBytes = input.session.expectedSizeBytes ?? input.requestedSizeBytes

  return {
    ...(digest === undefined ? {} : { digest }),
    ...(sizeBytes === undefined ? {} : { sizeBytes }),
  }
}

function expectedFileRefError(expected: ExpectedUploadIdentity, fileRef: FileRef): string | null {
  return (
    expectedSizeBytesValueError(expected.sizeBytes, fileRef.sizeBytes) ??
    expectedDigestError(expected.digest, fileRef.digest)
  )
}

function expectedDigestError(
  expectedDigest: BlobDigest | undefined,
  actualDigest: BlobDigest | undefined
): string | null {
  return expectedDigest !== undefined &&
    actualDigest !== undefined &&
    actualDigest !== expectedDigest
    ? `File upload digest mismatch: expected ${expectedDigest}, received ${actualDigest}.`
    : null
}

function expectedSizeBytesError(
  session: FileUploadSession,
  actualSizeBytes: number
): string | null {
  return expectedSizeBytesValueError(session.expectedSizeBytes, actualSizeBytes)
}

function expectedSizeBytesValueError(
  expectedSizeBytes: number | undefined,
  actualSizeBytes: number | undefined
): string | null {
  return expectedSizeBytes !== undefined &&
    actualSizeBytes !== undefined &&
    actualSizeBytes !== expectedSizeBytes
    ? `File upload size mismatch: expected ${expectedSizeBytes} bytes, received ${actualSizeBytes}.`
    : null
}

function requestSizeLimitError(request: Request, maxSizeBytes: number): string | null {
  const value = request.headers.get("content-length")
  if (value === null) {
    return null
  }

  const sizeBytes = Number(value)
  if (!Number.isSafeInteger(sizeBytes) || sizeBytes <= maxSizeBytes) {
    return null
  }

  return `File upload request exceeds the ${maxSizeBytes} byte limit.`
}

function expectedContentLengthError(session: FileUploadSession, request: Request): string | null {
  if (session.expectedSizeBytes === undefined) {
    return null
  }

  const value = request.headers.get("content-length")
  if (value === null) {
    return null
  }

  const sizeBytes = Number(value)
  if (!Number.isSafeInteger(sizeBytes)) {
    return null
  }

  return expectedSizeBytesError(session, sizeBytes)
}
