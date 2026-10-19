import { ARTIFACT_KINDS, ARTIFACT_STATE_LIMITS } from "@sixb/core/artifacts"
import { z } from "zod"
import { ErrorResponseSchema, PrincipalSchema } from "./common"
import { FileRefSchema } from "./files"

const ArtifactKindSchema = z.enum(ARTIFACT_KINDS)

const ArtifactFileSchema = z.object({
  path: z
    .string()
    .min(1)
    .describe("The file's path inside the artifact, such as figures/revenue.svg"),
  file: FileRefSchema,
})

const DocumentOutlineSchema = z.object({
  kind: z.literal("document"),
  headings: z.array(z.object({ depth: z.number().int(), text: z.string(), slug: z.string() })),
})

const SheetOutlineSchema = z.object({
  kind: z.literal("sheet"),
  sheets: z.array(
    z.object({ name: z.string(), rows: z.number().int(), columns: z.array(z.string()) })
  ),
  charts: z.array(z.string()),
})

const SlidesOutlineSchema = z.object({
  kind: z.literal("slides"),
  slides: z.array(z.object({ title: z.string().optional() })),
})

const PageOutlineSchema = z.object({ kind: z.literal("page"), title: z.string().optional() })

const CanvasOutlineSchema = z.object({
  kind: z.literal("canvas"),
  items: z.array(
    z.discriminatedUnion("type", [
      z.object({
        id: z.string(),
        type: z.literal("board"),
        title: z.string().optional(),
        file: z.string(),
        w: z.number(),
        h: z.number(),
      }),
      z.object({ id: z.string(), type: z.literal("section"), title: z.string().optional() }),
    ])
  ),
})

const FileOutlineSchema = z.object({ kind: z.literal("file"), mediaType: z.string() })

const ArtifactOutlineSchema = z.discriminatedUnion("kind", [
  DocumentOutlineSchema,
  SheetOutlineSchema,
  SlidesOutlineSchema,
  PageOutlineSchema,
  CanvasOutlineSchema,
  FileOutlineSchema,
])

const ArtifactReferenceSchema = z.object({
  address: z.string(),
  as: z.enum(["embed", "link"]),
  at: z.string(),
  resolvedVersion: z.number().int().positive(),
})

const ArtifactWarningSchema = z.object({
  code: z.string(),
  message: z.string(),
  part: z.string().optional(),
})

const ArtifactSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  kind: ArtifactKindSchema,
  title: z.string(),
  owner: PrincipalSchema,
  latestVersion: z.number().int().positive(),
  createdAt: z.string(),
  updatedAt: z.string(),
})

const ArtifactOriginSchema = z.object({ threadId: z.string(), runId: z.string() })

export const ArtifactVersionSchema = z.object({
  artifactId: z.string(),
  version: z.number().int().positive(),
  title: z.string(),
  entry: z.string(),
  files: z.array(ArtifactFileSchema),
  outline: ArtifactOutlineSchema,
  references: z.array(ArtifactReferenceSchema),
  author: PrincipalSchema,
  origin: ArtifactOriginSchema.optional(),
  createdAt: z.string(),
})

const ArtifactVersionSummarySchema = ArtifactVersionSchema.pick({
  version: true,
  title: true,
  author: true,
  origin: true,
  createdAt: true,
})

export const ArtifactParamsSchema = z.object({ artifactId: z.string().min(1) })

export const ArtifactVersionParamsSchema = ArtifactParamsSchema.extend({
  version: z
    .string()
    .regex(/^(?:latest|[1-9]\d*)$/)
    .describe('A version number, or "latest"'),
})

export const ArtifactListQuerySchema = z
  .object({
    thread: z
      .string()
      .min(1)
      .optional()
      .describe("Only artifacts with a version the Agent published in this thread"),
    kind: ArtifactKindSchema.optional().describe("Only artifacts of this kind"),
    limit: z.string().optional(),
    offset: z.string().optional(),
  })
  .strict()

export const ArtifactListResponseSchema = z.object({
  artifacts: z.array(ArtifactSchema),
  hasMore: z.boolean(),
  total: z.number().int(),
})

export const ArtifactResponseSchema = z.object({
  artifact: ArtifactSchema,
  versions: z.array(ArtifactVersionSummarySchema).describe("Newest first"),
})

export const PublishArtifactBodySchema = z
  .object({
    kind: ArtifactKindSchema,
    title: z.string(),
    files: z
      .array(ArtifactFileSchema)
      .min(1)
      .describe("Files stored with POST /api/files, at their paths in the artifact"),
  })
  .strict()

export const PublishArtifactVersionBodySchema = PublishArtifactBodySchema.extend({
  baseVersion: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(
      "The version this one was made from. When another was published since, the publish is refused with 409 artifact_moved, naming the latest version."
    ),
})

export const PublishedArtifactResponseSchema = z.object({
  artifact: ArtifactSchema,
  version: ArtifactVersionSchema,
  warnings: z.array(ArtifactWarningSchema),
})

export const DeleteArtifactResponseSchema = z.object({ deleted: z.literal(true) })

export const ArtifactStateParamsSchema = ArtifactParamsSchema.extend({
  key: z
    .string()
    .min(1)
    .max(ARTIFACT_STATE_LIMITS.maxKeyLength)
    .describe("The key a page keeps the value under, such as filters"),
})

const ArtifactStateEntrySchema = z.object({
  key: z.string(),
  value: z.unknown().describe("The JSON value"),
  updatedAt: z.string(),
})

export const ArtifactStateResponseSchema = z.object({
  entries: z.array(ArtifactStateEntrySchema).describe("By key, in order"),
})

export const SetArtifactStateBodySchema = z.object({
  value: z
    .unknown()
    .refine((value) => value !== undefined, "A value is required.")
    .describe(
      `Any JSON value: at most ${ARTIFACT_STATE_LIMITS.maxValueBytes / 1024} KB written out, within ${ARTIFACT_STATE_LIMITS.maxKeys} keys and ${ARTIFACT_STATE_LIMITS.maxBytes / 1024 / 1024} MB for each reader`
    ),
})

export const SetArtifactStateResponseSchema = ArtifactStateEntrySchema

export const DeleteArtifactStateResponseSchema = z.object({ deleted: z.boolean() })

export const ClearArtifactStateResponseSchema = z.object({
  cleared: z.number().int().describe("How many values were deleted"),
})

export const ArtifactFrameResponseSchema = z.object({
  path: z
    .string()
    .describe(
      "The frame's base path on this API, ending in /; the deck's entry is served under it"
    ),
  expiresAt: z.string().describe("When the frame stops serving; ask for a new one before then"),
})

export const ArtifactErrorResponseSchema = ErrorResponseSchema.extend({
  code: z
    .string()
    .optional()
    .describe(
      "Stable machine-readable failure code: artifact_not_found, artifact_kind_mismatch, artifact_moved, invalid_artifact, invalid_state, state_full, not_allowed, or storage_unavailable."
    ),
  latest: z
    .object({ version: z.number().int(), author: PrincipalSchema })
    .optional()
    .describe("With artifact_moved: the latest version and who published it"),
})
