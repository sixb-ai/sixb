import { ARTIFACT_KINDS, ARTIFACT_STATE_LIMITS } from "@sixb/core/artifacts"
import { ARTIFACT_RESTORE_POINTS } from "@sixb/core/internal/storage"
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
    z.object({
      name: z.string(),
      rows: z.number().int().describe("The rows of its CSV; none for a live sheet"),
      columns: z.array(z.string()),
      query: z
        .string()
        .optional()
        .describe("A live sheet's query, queries/<name>.json, whose rows each reader reads"),
    })
  ),
  charts: z.array(z.string()),
})

const SlidesOutlineSchema = z.object({
  kind: z.literal("slides"),
  slides: z.array(z.object({ title: z.string().optional() })),
})

const PageOutlineSchema = z.object({ kind: z.literal("page"), title: z.string().optional() })

const ArtifactThemeModeSchema = z.enum(["light", "dark"])

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
        renderKey: z
          .string()
          .optional()
          .describe("What the board's preview is a picture of: a board kept as it was keeps it"),
      }),
      z.object({ id: z.string(), type: z.literal("section"), title: z.string().optional() }),
    ])
  ),
  themes: z
    .array(ArtifactThemeModeSchema)
    .optional()
    .describe("The modes each board has a preview in: both, or the one its theme.json pins"),
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

const RevisionSchema = z
  .number()
  .int()
  .positive()
  .describe(
    "Counts the artifact's changes: a write, a version created, a restore. It only grows, so content read at one revision is that revision's for good"
  )

const ArtifactSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  kind: ArtifactKindSchema,
  title: z.string(),
  owner: PrincipalSchema,
  latestVersion: z.number().int().positive(),
  revision: RevisionSchema,
  createdAt: z.string(),
  updatedAt: z.string().describe("When the artifact last changed"),
})

const ArtifactOriginSchema = z.object({ threadId: z.string(), runId: z.string() })

export const ArtifactVersionSchema = z.object({
  artifactId: z.string(),
  version: z.number().int().positive(),
  revision: RevisionSchema.describe(
    "The artifact's revision when this version last changed: the latest version's is the artifact's"
  ),
  frozen: z
    .boolean()
    .describe(
      "Someone created this version: it never changes again. The latest version is open until then, and each write replaces its content"
    ),
  title: z.string(),
  entry: z.string(),
  files: z.array(ArtifactFileSchema),
  outline: ArtifactOutlineSchema,
  references: z.array(ArtifactReferenceSchema),
  author: PrincipalSchema.describe("Who last wrote its content"),
  origin: ArtifactOriginSchema.optional().describe(
    "The Agent turn and thread its content was last written from"
  ),
  createdAt: z.string().describe("When the version was opened"),
  updatedAt: z.string().describe("When its content was last written"),
  frozenAt: z.string().optional().describe("When it was created, which froze it"),
  frozenBy: PrincipalSchema.optional().describe("Who created it"),
  boardPreviews: z
    .record(z.string(), z.enum(["ready", "pending", "none"]))
    .optional()
    .describe(
      "A canvas's boards by id, as reading or publishing the version returns them: ready when its preview is, pending while it is rendered, none when none will come and the board shows its outline"
    ),
})

const ArtifactVersionSummarySchema = ArtifactVersionSchema.pick({
  version: true,
  revision: true,
  frozen: true,
  title: true,
  author: true,
  origin: true,
  createdAt: true,
  updatedAt: true,
  frozenAt: true,
  frozenBy: true,
})

export const ArtifactParamsSchema = z.object({ artifactId: z.string().min(1) })

export const ArtifactVersionParamsSchema = ArtifactParamsSchema.extend({
  version: z
    .string()
    .regex(/^(?:latest|[1-9]\d*)$/)
    .describe('A version number, or "latest"'),
})

export const ArtifactBoardPreviewParamsSchema = ArtifactVersionParamsSchema.extend({
  board: z.string().min(1).describe("The board's id in the canvas"),
})

export const ArtifactBoardPreviewQuerySchema = z
  .object({
    theme: ArtifactThemeModeSchema.optional().describe(
      "The reader's mode; a canvas whose theme.json pins one is pictured only in it"
    ),
    size: z
      .enum(["full", "small"])
      .optional()
      .describe(
        "full, the default: a PNG of the board at its own size. small: a WebP at most 480 pixels wide, for a canvas that shows many boards at once"
      ),
    revision: z.coerce
      .number()
      .int()
      .min(1)
      .optional()
      .describe(
        "The version's revision the picture is of. Another than the version's current one is 404 preview_not_found: the version changed, and says which pictures it has now. One that matches is cached for good"
      ),
  })
  .strict()

export const ArtifactQueryParamsSchema = ArtifactVersionParamsSchema.extend({
  name: z.string().min(1).describe("The query's name: queries/<name>.json in the version"),
})

export const ArtifactListQuerySchema = z
  .object({
    thread: z
      .string()
      .min(1)
      .optional()
      .describe("Only artifacts this conversation shares: the Agent wrote them in it"),
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
  access: z
    .enum(["owner", "update", "read"])
    .describe(
      "What the caller may do with it: everything as its owner, publish and keep page data as a participant of a conversation that shares it, or only read as an observer of one"
    ),
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

const BaseRevisionSchema = z
  .number()
  .int()
  .positive()
  .optional()
  .describe(
    "The revision this was made from. When the artifact changed since, it is refused with 409 artifact_moved, naming the revision and who last wrote the latest version."
  )

export const UpdateArtifactBodySchema = PublishArtifactBodySchema.extend({
  baseRevision: BaseRevisionSchema,
})

export const FreezeArtifactBodySchema = z
  .object({ baseRevision: BaseRevisionSchema })
  .strict()
  .default({})

export const RestoreArtifactBodySchema = z
  .object({ baseRevision: BaseRevisionSchema })
  .strict()
  .default({})

export const ArtifactRestorePointParamsSchema = ArtifactParamsSchema.extend({
  revision: z
    .string()
    .regex(/^[1-9]\d*$/)
    .describe("The revision whose content the restore point holds"),
})

/** A restore point without its files: the list a Restore menu shows. */
const ArtifactRestorePointSummarySchema = z.object({
  artifactId: z.string(),
  revision: RevisionSchema.describe("The revision whose content it holds, which restores it"),
  version: z.number().int().positive().describe("The version it was taken of"),
  frozen: z
    .boolean()
    .describe(
      "Whether that version was already created, and so frozen, when the point was taken: its content is then that version's"
    ),
  title: z.string(),
  author: PrincipalSchema.describe("Who had last written that content"),
  origin: ArtifactOriginSchema.optional(),
  updatedAt: z.string().describe("When that content was written"),
  reason: z
    .enum(["turn", "restore"])
    .describe("Taken before an Agent turn's first write to the artifact, or before a restore"),
  turnRunId: z.string().optional().describe("With turn: the turn's run"),
  createdAt: z.string().describe("When it was taken"),
})

export const ArtifactRestorePointSchema = ArtifactRestorePointSummarySchema.extend({
  entry: z.string(),
  files: z.array(ArtifactFileSchema),
  outline: ArtifactOutlineSchema,
  references: z.array(ArtifactReferenceSchema),
})

export const ArtifactRestorePointListResponseSchema = z.object({
  restorePoints: z
    .array(ArtifactRestorePointSummarySchema)
    .describe(`Newest first: an artifact keeps its last ${ARTIFACT_RESTORE_POINTS}`),
})

export const ArtifactChangeResponseSchema = z.object({
  artifact: ArtifactSchema,
  version: ArtifactVersionSchema,
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
      "Stable machine-readable failure code: artifact_not_found, artifact_kind_mismatch, artifact_moved, restore_point_not_found, invalid_artifact, invalid_state, state_full, not_allowed, not_shared (it exists but no conversation you read shares it), read_only (you observe the conversation that shares it), query_not_found, query_invalid (the ontology no longer admits the query), preview_not_found (the board has no preview yet, or will have none), execution_lost (a run token's run ended or moved to another runner), or storage_unavailable."
    ),
  latest: z
    .object({
      version: z.number().int(),
      revision: z.number().int(),
      author: PrincipalSchema,
      frozenBy: PrincipalSchema.optional(),
    })
    .optional()
    .describe(
      "With artifact_moved: the artifact's latest version, its revision, who last wrote it, and who created it once it is frozen"
    ),
})
