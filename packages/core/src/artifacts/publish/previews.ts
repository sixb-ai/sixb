import { createHash } from "node:crypto"
import type { Principal } from "../../auth"
import { statFileRef } from "../../blob-storage/file-content"
import type { BlobStorage, FileRef } from "../../blob-storage/types"
import { isValidFileRef } from "../../blob-storage/validation"
import type { AgentQueueJob, Queue } from "../../queues"
import type {
  ArtifactBoardPreviewRecord,
  ArtifactBoardPreviewSize,
  ArtifactFile,
  ArtifactStorage,
  ArtifactVersionRecord,
} from "../../storage/artifacts/types"
import { CANVAS_FILE } from "../canvas"
import { BOARD_PREVIEW_JOB, BOARD_PREVIEW_WAIT_MS } from "../canvas-display"
import { ArtifactRequestError } from "../errors"
import { FRAME_ASSETS } from "../frames/assets"
import { FRAME_DEFAULT_THEMES } from "../frames/kit"
import type { ArtifactOutline, CanvasOutline, CanvasOutlineItem } from "../outline"
import { type ArtifactQueryResult, artifactQueryName } from "../queries"
import type { ArtifactThemeMode } from "../theme"
import { answerArtifactQueries } from "./query-answers"

// A canvas's boards are pages, and a hundred pages cannot all run at once: the app shows each as
// a picture until it is read. The picture is derived data, kept apart from the version by what it
// shows, its render key, so a version that keeps a board as it was keeps its picture.
//
// Whoever publishes a version may render its pictures, as the Agent's layout check does; what is
// still missing is rendered by the agent worker in a blank sandbox. Either way the board runs with
// the data its version's author can see: never more.

/** A board's picture in one mode and size, as its renderer hands it over. */
export interface BoardPreviewInput {
  /** The board's id in the version. */
  readonly board: string
  readonly theme: ArtifactThemeMode
  readonly size: ArtifactBoardPreviewSize
  /** A PNG at full size, a WebP when small. */
  readonly file: FileRef
}

/** What each size of picture is stored as. */
export const BOARD_PREVIEW_MEDIA_TYPES: Readonly<Record<ArtifactBoardPreviewSize, string>> = {
  full: "image/png",
  small: "image/webp",
}

const SIZES: readonly ArtifactBoardPreviewSize[] = ["full", "small"]

/** A board of a version whose picture is missing, in either size, in some of its modes. */
export interface MissingBoardPreview {
  readonly board: CanvasOutlineBoard
  readonly renderKey: string
  readonly themes: readonly ArtifactThemeMode[]
}

/** Whether a board's picture can be shown, will be, or will not come. */
export type BoardPreviewStatus = "ready" | "pending" | "none"

export type CanvasOutlineBoard = Extract<CanvasOutlineItem, { readonly type: "board" }>

/** Asks for what is missing of a stored version's pictures; see {@link requestBoardPreviews}. */
export type BoardPreviewRequester = (
  version: ArtifactVersionRecord,
  options?: BoardPreviewRequestOptions
) => Promise<void>

export interface BoardPreviewRequestOptions {
  /** The publisher renders the pictures itself: the worker waits this long for them. */
  readonly delayMs?: number
  /**
   * Leaves the version's queries unanswered: the worker then pictures only the boards that read
   * none, and a board that reads one keeps its outline.
   */
  readonly withoutAnswers?: boolean
}

/**
 * The largest picture of a board kept. Most boards' full pictures are far smaller, but a busy
 * board as wide as 8000 pixels can pass it: that picture is not kept, and the board shows its
 * outline in that size.
 */
export const MAX_BOARD_PREVIEW_BYTES = 8 * 1024 * 1024

const RENDER_KEY_FORMAT = "sixb-board-preview/1"

/**
 * What a board's picture is of, as a SHA-256: its HTML and size, every file it could load (each
 * of the version's but `canvas.json` and the other boards' HTML), the frame's kit, runtime and
 * themes it runs in, and its author, so no one can hand over a picture under another author's key.
 * `theme.json` is one of the files, so the modes and tokens it sets are in the key too.
 *
 * When the version holds queries the picture shows its author's data, to the artifact's readers:
 * the key names the artifact too, so a copy, read by others, never shows the original's picture.
 */
export function boardRenderKey(input: {
  readonly board: Pick<CanvasOutlineBoard, "file" | "w" | "h">
  readonly files: readonly ArtifactFile[]
  /** Every board's HTML file in the version: the others are not this board's to load. */
  readonly boardFiles: ReadonlySet<string>
  readonly author: Principal
  readonly artifactId: string
}): string {
  const { board, files, boardFiles, author } = input

  const loaded = files
    .filter(
      (entry) =>
        entry.path !== CANVAS_FILE && (entry.path === board.file || !boardFiles.has(entry.path))
    )
    .map((entry) => [entry.path, entry.file.digest] as const)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))

  const audience = boardsReadLiveData({ files }) ? input.artifactId : null

  return createHash("sha256")
    .update(
      JSON.stringify([
        RENDER_KEY_FORMAT,
        frameKitDigest(),
        board.file,
        board.w,
        board.h,
        [author.type, author.id],
        audience,
        loaded,
      ])
    )
    .digest("hex")
}

/** A canvas's outline with the modes its boards are pictured in. */
export function canvasPreviewOutline(
  outline: CanvasOutline,
  themes: readonly ArtifactThemeMode[]
): CanvasOutline {
  return { ...outline, themes: [...themes] }
}

/**
 * A version with each of its canvas's boards named by its render key, for the artifact it is
 * stored in. Any other kind stays as it is.
 */
export function withBoardRenderKeys<
  TVersion extends Pick<ArtifactVersionRecord, "outline" | "files" | "author">,
>(version: TVersion, artifactId: string): TVersion {
  const { outline } = version
  if (outline.kind !== "canvas") return version

  const boardFiles = new Set(
    outline.items.flatMap((item) => (item.type === "board" ? [item.file] : []))
  )
  return {
    ...version,
    outline: {
      ...outline,
      items: outline.items.map((item) =>
        item.type === "board"
          ? {
              ...item,
              renderKey: boardRenderKey({
                board: item,
                files: version.files,
                boardFiles,
                author: version.author,
                artifactId,
              }),
            }
          : item
      ),
    },
  }
}

/**
 * The outline a copy's version takes in place of the source's: a canvas whose boards show their
 * author's data is named anew for the copy, so it gets none of the source's pictures and its
 * boards run live for its readers. `undefined` when the version's outline stays as it is.
 */
export function copiedVersionOutline(
  version: ArtifactVersionRecord,
  copyId: string
): ArtifactOutline | undefined {
  if (version.outline.kind !== "canvas" || !boardsReadLiveData(version)) return undefined

  return withBoardRenderKeys(version, copyId).outline
}

/** The boards of a version with a render key, and the modes each has a picture in. */
function previewedBoards(version: ArtifactVersionRecord): {
  readonly boards: readonly (CanvasOutlineBoard & { readonly renderKey: string })[]
  readonly themes: readonly ArtifactThemeMode[]
} {
  const { outline } = version
  if (outline.kind !== "canvas" || !outline.themes) return { boards: [], themes: [] }

  return {
    boards: outline.items.flatMap((item) =>
      item.type === "board" && item.renderKey ? [{ ...item, renderKey: item.renderKey }] : []
    ),
    themes: outline.themes,
  }
}

/** Whether a version holds queries: its boards then show its author's data. */
export function boardsReadLiveData(version: Pick<ArtifactVersionRecord, "files">): boolean {
  return version.files.some((file) => artifactQueryName(file.path) !== undefined)
}

/** The pictures a version's boards have, by board id: each in its modes and sizes. */
export async function boardPreviews(
  storage: Pick<ArtifactStorage, "listBoardPreviews">,
  version: ArtifactVersionRecord
): Promise<ReadonlyMap<string, readonly ArtifactBoardPreviewRecord[]>> {
  const { boards } = previewedBoards(version)
  if (boards.length === 0) return new Map()

  const stored = await storage.listBoardPreviews({
    projectId: version.projectId,
    renderKeys: [...new Set(boards.map((board) => board.renderKey))],
  })

  return new Map(
    boards.map((board) => [
      board.id,
      stored.filter((preview) => preview.renderKey === board.renderKey),
    ])
  )
}

/** A board's picture in one mode and size, among its pictures. */
export function boardPreview(
  pictures: readonly ArtifactBoardPreviewRecord[] | undefined,
  theme: ArtifactThemeMode,
  size: ArtifactBoardPreviewSize
): ArtifactBoardPreviewRecord | undefined {
  return pictures?.find((picture) => picture.theme === theme && picture.size === size)
}

/** Whether a board has its pictures in a mode: both sizes, which its renderer takes together. */
function pictured(
  pictures: readonly ArtifactBoardPreviewRecord[] | undefined,
  theme: ArtifactThemeMode
): boolean {
  return SIZES.every((size) => boardPreview(pictures, theme, size))
}

/** The boards of a version still without a picture in one of its modes, in the canvas's order. */
export async function missingBoardPreviews(
  storage: Pick<ArtifactStorage, "listBoardPreviews">,
  version: ArtifactVersionRecord
): Promise<readonly MissingBoardPreview[]> {
  const { boards, themes } = previewedBoards(version)
  const stored = await boardPreviews(storage, version)

  return boards.flatMap((board) => {
    const missing = themes.filter((theme) => !pictured(stored.get(board.id), theme))
    return missing.length === 0 ? [] : [{ board, renderKey: board.renderKey, themes: missing }]
  })
}

/**
 * Each board's picture as a reader asks for it: `ready` in every mode, `pending` while one may
 * still come, `none` when nothing will render it: a project without sandboxes, a version from
 * before pictures, or one past the wait.
 */
export async function boardPreviewStatuses(
  storage: Pick<ArtifactStorage, "listBoardPreviews">,
  version: ArtifactVersionRecord,
  input: { readonly renders: boolean; readonly now: Date }
): Promise<ReadonlyMap<string, BoardPreviewStatus>> {
  const { boards, themes } = previewedBoards(version)
  const stored = await boardPreviews(storage, version)
  const waiting =
    input.renders && input.now.getTime() - version.createdAt.getTime() < BOARD_PREVIEW_WAIT_MS

  return new Map(
    boards.map((board) => {
      const ready = themes.every((theme) => pictured(stored.get(board.id), theme))
      return [board.id, ready ? "ready" : waiting ? "pending" : "none"] as const
    })
  )
}

/**
 * Keeps pictures of a stored version's boards, each under its board's render key. Who may hand
 * them over is the caller's decision: only whoever rendered them with the author's data. Refuses
 * a board or a mode the version has no picture for, and anything but a stored PNG at full size or
 * WebP when small.
 */
export async function storeBoardPreviews(
  context: {
    readonly storage: Pick<ArtifactStorage, "putBoardPreviews">
    readonly blobStorage: Pick<BlobStorage, "stat">
  },
  version: ArtifactVersionRecord,
  previews: readonly BoardPreviewInput[]
): Promise<void> {
  if (previews.length === 0) return

  const { boards, themes } = previewedBoards(version)
  const keys = new Map(boards.map((board) => [board.id, board.renderKey]))
  const createdAt = new Date()

  const records = await Promise.all(
    previews.map(async (preview) => {
      const renderKey = keys.get(preview.board)
      if (!renderKey || !themes.includes(preview.theme)) {
        throw invalidPreview(
          `Version ${version.version} of '${version.artifactId}' has no board '${preview.board}' to picture in ${preview.theme} mode.`
        )
      }

      const { file, size } = preview
      const mediaType = SIZES.includes(size) ? BOARD_PREVIEW_MEDIA_TYPES[size] : undefined
      if (
        !mediaType ||
        !isValidFileRef(file) ||
        file.mediaType !== mediaType ||
        file.sizeBytes > MAX_BOARD_PREVIEW_BYTES
      ) {
        throw invalidPreview(
          `The ${size} picture of board '${preview.board}' must be ${mediaType ?? "full or small"} of at most ${MAX_BOARD_PREVIEW_BYTES} bytes.`
        )
      }
      if (!(await statFileRef(context.blobStorage, file))) {
        throw invalidPreview(`The picture of board '${preview.board}' is not stored.`)
      }

      return { renderKey, theme: preview.theme, size, file: { ...file }, createdAt }
    })
  )

  await context.storage.putBoardPreviews({ projectId: version.projectId, previews: records })
}

/** One job per version: asking again for the same version is the same job. */
export function boardPreviewsJobId(artifactId: string, version: number): string {
  return `art_previews_${artifactId}_v${version}`
}

/**
 * Asks the agent worker to render what a stored version's boards still miss, after `delayMs` when
 * its publisher renders them itself. Nothing is asked when nothing is missing.
 *
 * Boards that read queries show their author's data, so the version's queries are answered now,
 * by `query`, as whoever just published it, and the job carries the answers: kept as a blob only
 * the job names. A query that fails is answered as its rejection.
 *
 * The version exists by now and its pictures are derived from it, so a request that fails is
 * reported, not thrown: the publish succeeded, and the viewer shows the boards' outlines instead.
 */
export async function requestBoardPreviews(
  input: {
    readonly storage: Pick<ArtifactStorage, "listBoardPreviews">
    readonly queue: Pick<Queue<AgentQueueJob>, "enqueue">
    readonly blobStorage: Pick<BlobStorage, "put">
    /** Runs one of the version's queries as its publisher. */
    readonly query: (name: string) => Promise<ArtifactQueryResult | null>
  },
  version: ArtifactVersionRecord,
  options: BoardPreviewRequestOptions = {}
): Promise<void> {
  if (version.outline.kind !== "canvas") return

  try {
    if ((await missingBoardPreviews(input.storage, version)).length === 0) return

    const queries =
      boardsReadLiveData(version) && !options.withoutAnswers
        ? await storeQueryAnswers(input, version)
        : undefined

    await input.queue.enqueue({
      projectId: version.projectId,
      jobs: [
        {
          id: boardPreviewsJobId(version.artifactId, version.version),
          type: "agent.artifact-previews.requested",
          payload: {
            artifactId: version.artifactId,
            version: version.version,
            ...(queries ? { queries } : {}),
          },
          ...(options.delayMs
            ? { availableAt: new Date(Date.now() + options.delayMs).toISOString() }
            : {}),
        },
      ],
    })
  } catch (error) {
    console.error(
      `[Sixb] Could not ask for the previews of version ${version.version} of '${version.artifactId}'; its boards show their outlines.`,
      error
    )
  }
}

/** The version's query answers, as its publisher reads them, as a JSON blob. */
async function storeQueryAnswers(
  input: {
    readonly blobStorage: Pick<BlobStorage, "put">
    readonly query: (name: string) => Promise<ArtifactQueryResult | null>
  },
  version: ArtifactVersionRecord
): Promise<FileRef> {
  const answers = await answerArtifactQueries(version, input.query)
  const body = new TextEncoder().encode(JSON.stringify(answers))

  return input.blobStorage.put({
    body,
    expectedSizeBytes: body.byteLength,
    fileName: `${version.artifactId}-v${version.version}-queries.json`,
    mediaType: "application/json",
  })
}

let kitDigest: string | undefined

/** What a board runs with besides its own files: a new kit renders it anew. */
function frameKitDigest(): string {
  kitDigest ??= createHash("sha256")
    .update(JSON.stringify([FRAME_ASSETS, FRAME_DEFAULT_THEMES]))
    .digest("hex")
  return kitDigest
}

function invalidPreview(message: string): ArtifactRequestError {
  return new ArtifactRequestError("invalid_artifact", `[Sixb] ${message}`)
}
