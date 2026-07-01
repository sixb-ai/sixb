import { z } from "zod"

export const BlobDigestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/)

export const FileRefSchema = z.object({
  blobId: z.string(),
  digest: BlobDigestSchema,
  sizeBytes: z.number().int().nonnegative(),
  fileName: z.string().optional(),
  mediaType: z.string().optional(),
  logicalPath: z.string().optional(),
})

export const CreateFileUploadBodySchema = z.object({
  fileName: z.string().optional(),
  mediaType: z.string().optional(),
  sizeBytes: z.number().int().nonnegative().optional(),
  digest: BlobDigestSchema.optional(),
  logicalPath: z.string().optional(),
})

export const FileUploadIdParamsSchema = z.object({
  uploadId: z.string().min(1),
})

export const FileUploadPartParamsSchema = FileUploadIdParamsSchema.extend({
  partNumber: z.string().regex(/^\d+$/),
})

export const ServerFileUploadSchema = z.object({
  strategy: z.literal("server"),
  uploadId: z.string(),
  method: z.literal("PUT"),
  url: z.string(),
  expiresAt: z.string(),
})

export const DirectPutFileUploadSchema = z.object({
  strategy: z.literal("direct-put"),
  uploadId: z.string(),
  method: z.literal("PUT"),
  url: z.string(),
  headers: z.record(z.string()),
  expiresAt: z.string(),
})

export const MultipartFileUploadSchema = z.object({
  strategy: z.literal("multipart"),
  uploadId: z.string(),
  partSizeBytes: z.number().int().positive(),
  expiresAt: z.string(),
})

export const CreateFileUploadResponseSchema = z.discriminatedUnion("strategy", [
  ServerFileUploadSchema,
  DirectPutFileUploadSchema,
  MultipartFileUploadSchema,
])

export const SignedFileUploadPartSchema = z.object({
  partNumber: z.number().int().positive(),
  method: z.literal("PUT"),
  url: z.string(),
  headers: z.record(z.string()),
  expiresAt: z.string(),
})

export const FileUploadPartSchema = z.object({
  partNumber: z.number().int().positive(),
  etag: z.string(),
})

export const CompleteFileUploadBodySchema = z
  .object({
    sizeBytes: z.number().int().nonnegative().optional(),
    digest: BlobDigestSchema.optional(),
    parts: z.array(FileUploadPartSchema).optional(),
  })
  .optional()

export const FileContentQuerySchema = z.object({
  path: z.string().min(1),
  disposition: z.enum(["inline", "attachment"]).optional(),
})
