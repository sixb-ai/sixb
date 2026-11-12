import { ARTIFACT_HOLDERS_LIMIT, ARTIFACT_KINDS, ARTIFACT_STATE_LIMITS } from "@sixb/core/artifacts"
import { ARTIFACT_RESTORE_POINTS } from "@sixb/core/internal/storage"
import { z } from "zod"
import { ErrorResponseSchema, PrincipalSchema } from "./common"
import { FileRefSchema, ShareGrantQuerySchema } from "./files"

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
  format: z
    .literal("html")
    .optional()
    .describe("html for a designed document, document.html with its own stylesheets"),
  paper: z
    .object({
      width: z.number(),
      height: z.number(),
      margin: z.object({
        top: z.number(),
        right: z.number(),
        bottom: z.number(),
        left: z.number(),
      }),
    })
    .optional()
    .describe(
      "The sheet a designed document's @page rule sets, in CSS pixels: its size and margins"
    ),
  holder: z
    .object({
      objectTypeId: z.string(),
      links: z.array(z.string()).describe("The holder's links its fields read through"),
    })
    .optional()
    .describe(
      'The object a designed document shows live data of, as <meta name="sixb:object-type"> names its type: the one object of that type that holds the document'
    ),
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
  pdf: z
    .enum(["ready", "printable", "failed"])
    .optional()
    .describe(
      "A designed document's PDF: ready once printed, printable when asking for it prints it, failed when it could not be printed. Absent when the version cannot print: not a designed document, or a project without sandboxes"
    ),
})

export const ArtifactPdfResponseSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("ready"),
    pages: z.number().int().min(1).describe("How many pages it printed on"),
  }),
  z.object({ status: z.literal("printing") }),
  z.object({
    status: z.literal("failed"),
    reason: z.string().describe("Why it could not be printed"),
  }),
])

export const ArtifactPdfQuerySchema = z.object({
  retry: z
    .enum(["true", "false"])
    .optional()
    .describe("true asks again for a PDF that could not be printed, instead of hearing why"),
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
    key: z
      .string()
      .min(1)
      .max(200)
      .optional()
      .describe(
        "The board's render key the picture is of, as the version's outline names it, in place of revision: the picture stays the same while the board shows the same, however often the canvas around it changes. Another than the board's current one is 404 preview_not_found. One that matches is cached for good"
      ),
  })
  .extend(ShareGrantQuerySchema.shape)
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
      "What the caller may do with it: everything as its owner, publish and keep page data as a participant of a conversation that shares it or an editor of an object that holds it, or only read as an observer of such a conversation or a reader of such an object"
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

export const ArtifactHolderSchema = z.object({
  objectTypeId: z.string(),
  primaryId: z.string(),
  propertyId: z.string().describe("The property whose value holds the artifact"),
  title: z
    .string()
    .optional()
    .describe("The object's value of its type's search title, when it has one you read"),
})

export const ArtifactHolderListResponseSchema = z.object({
  holders: z
    .array(ArtifactHolderSchema)
    .describe(`The first ${ARTIFACT_HOLDERS_LIMIT} objects you read that hold the artifact`),
  hasMore: z.boolean().describe("More objects you read hold it"),
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
      "Stable machine-readable failure code: artifact_not_found, artifact_kind_mismatch, artifact_moved, restore_point_not_found, comment_not_found, invalid_artifact, invalid_comment, invalid_state, name_required (a shared link's guest gives their name before commenting), state_full, comments_full, not_allowed, not_shared (it exists but neither a conversation nor an object you read shares it), read_only (you only read it), query_not_found, holder_not_found (no one object of the type a designed document names that you read holds it), query_invalid (the ontology no longer admits the query), preview_not_found (the board has no preview yet, or will have none), pdf_not_found (the document is not printed yet: ask for it first), pdf_unavailable (the project has no sandboxes to print in), execution_lost (a run token's run ended or moved to another runner), or storage_unavailable."
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

const ArtifactCommentAnchorSchema = z.object({
  board: z.string().max(200).optional().describe("The id of the canvas's board it is about"),
  element: z
    .string()
    .max(1024)
    .optional()
    .describe("The address of the board's element it is about, such as body>main:0>h1:0"),
  label: z
    .string()
    .max(1000)
    .optional()
    .describe("The element's first words, which name it once it is gone; kept to 120 characters"),
  point: z
    .object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1) })
    .optional()
    .describe(
      "Where on the board its pin is, as fractions of the board's width and height from its top left"
    ),
  revision: RevisionSchema.describe("The artifact's revision its author saw"),
})

const ArtifactCommentAuthorSchema = z
  .object({
    type: z.enum(["user", "serviceAccount", "system", "guest"]),
    id: z.string().min(1),
  })
  .describe(
    "Who wrote it: a principal, or a guest, someone without an account who opened a shared link, whose id is their link's session"
  )

export const ArtifactCommentSchema = z.object({
  artifactId: z.string(),
  id: z.string(),
  parentId: z.string().optional().describe("The comment it replies to, for a reply"),
  anchor: ArtifactCommentAnchorSchema,
  body: z.string().describe("Plain text"),
  author: ArtifactCommentAuthorSchema,
  authorName: z
    .string()
    .nullable()
    .describe(
      "Its author's name: a member's profile name or email, the project's for its own code, or the name a guest gave; null for anyone the project cannot name. A guest reading it never gets a member's email"
    ),
  origin: z
    .object({ threadId: z.string(), runId: z.string() })
    .optional()
    .describe("The Agent's run that wrote it for its author, and that run's conversation"),
  createdAt: z.string(),
  resolvedAt: z.string().optional().describe("When someone marked it resolved"),
  resolvedBy: PrincipalSchema.optional().describe("Who marked it resolved"),
})

export const ArtifactCommentListResponseSchema = z.object({
  comments: z.array(ArtifactCommentSchema).describe("Comments and replies, oldest first"),
})

export const ArtifactCommentParamsSchema = ArtifactParamsSchema.extend({
  commentId: z.string().min(1).max(64),
})

export const AddArtifactCommentBodySchema = z.object({
  body: z.string().min(1).max(4_000).describe("Plain text"),
  anchor: ArtifactCommentAnchorSchema.partial()
    .optional()
    .describe(
      "What it is about: a board, an element of the board, or, without, the artifact; at the artifact's revision by default. A reply is about what it replies to."
    ),
  parentId: z.string().min(1).max(64).optional().describe("The comment it replies to"),
})

export const ResolveArtifactCommentBodySchema = z.object({
  resolved: z.boolean().default(true).describe("False opens it again"),
})

export const DeleteArtifactCommentResponseSchema = z.object({ deleted: z.literal(true) })
