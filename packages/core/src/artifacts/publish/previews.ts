import { createHash } from "node:crypto"
import type { Principal } from "../../auth"
import { statFileRef } from "../../blob-storage/file-content"
import type { BlobStorage, FileRef } from "../../blob-storage/types"
import { isValidFileRef } from "../../blob-storage/validation"
import type { AgentQueueJob, Queue } from "../../queues"
import type {
  ArtifactBoardPreviewRecord,
  ArtifactFile,
  ArtifactStorage,
  ArtifactVersionRecord,
} from "../../storage/artifacts/types"
import { BOARD_PREVIEW_WAIT_MS, CANVAS_FILE } from "../canvas"
import { ArtifactRequestError } from "../errors"
import { FRAME_ASSETS } from "../frames/assets"
import { FRAME_DEFAULT_THEMES } from "../frames/kit"
import type { CanvasOutline, CanvasOutlineItem } from "../outline"
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

/** A board's picture in one mode, as its renderer hands it over: a PNG. */
export interface BoardPreviewInput {
  /** The board's id in the version. */
  readonly board: string
  readonly theme: ArtifactThemeMode
  readonly file: FileRef
}

/** A board of a version whose picture is missing in some of its modes. */
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
  options?: { readonly delayMs?: number }
) => Promise<void>

/** The largest picture of a board kept: a board of 8000 by 4000 pixels fits many times over. */
export const MAX_BOARD_PREVIEW_BYTES = 8 * 1024 * 1024

/**
 * How long a publisher that renders its own pictures, as the Agent's layout check does within its
 * 120 seconds, has before the worker renders what is still missing.
 */
export const BOARD_PREVIEW_GRACE_MS = 180_000

const RENDER_KEY_FORMAT = "sixb-board-preview/1"

/**
 * What a board's picture is of, as a SHA-256: its HTML and size, every file it could load (each
 * of the version's but `canvas.json` and the other boards' HTML), the frame's kit, runtime and
 * themes it runs in, and, when the version holds queries, its author, whose data it shows.
 * `theme.json` is one of the files, so the modes and tokens it sets are in the key too.
 */
export function boardRenderKey(input: {
  readonly board: Pick<CanvasOutlineBoard, "file" | "w" | "h">
  readonly files: readonly ArtifactFile[]
  /** Every board's HTML file in the version: the others are not this board's to load. */
  readonly boardFiles: ReadonlySet<string>
  readonly author: Principal
}): string {
  const { board, files, boardFiles, author } = input

  const loaded = files
    .filter(
      (entry) =>
        entry.path !== CANVAS_FILE && (entry.path === board.file || !boardFiles.has(entry.path))
    )
    .map((entry) => [entry.path, entry.file.digest] as const)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))

  // Two authors' identical boards show each one's rows: they are two pictures.
  const live = files.some((entry) => artifactQueryName(entry.path) !== undefined)

  return createHash("sha256")
    .update(
      JSON.stringify([
        RENDER_KEY_FORMAT,
        frameKitDigest(),
        board.file,
        board.w,
        board.h,
        live ? [author.type, author.id] : null,
        loaded,
      ])
    )
    .digest("hex")
}

/** A canvas's outline with each board's render key and the modes its pictures are in. */
export function canvasPreviewOutline(
  outline: CanvasOutline,
  input: {
    readonly files: readonly ArtifactFile[]
    readonly author: Principal
    readonly themes: readonly ArtifactThemeMode[]
  }
): CanvasOutline {
  const boardFiles = new Set(
    outline.items.flatMap((item) => (item.type === "board" ? [item.file] : []))
  )

  return {
    ...outline,
    themes: [...input.themes],
    items: outline.items.map((item) =>
      item.type === "board"
        ? {
            ...item,
            renderKey: boardRenderKey({
              board: item,
              files: input.files,
              boardFiles,
              author: input.author,
            }),
          }
        : item
    ),
  }
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

/** The pictures a version's boards have, by board id and mode. */
export async function boardPreviews(
  storage: Pick<ArtifactStorage, "listBoardPreviews">,
  version: ArtifactVersionRecord
): Promise<ReadonlyMap<string, ReadonlyMap<ArtifactThemeMode, ArtifactBoardPreviewRecord>>> {
  const { boards } = previewedBoards(version)
  if (boards.length === 0) return new Map()

  const stored = await storage.listBoardPreviews({
    projectId: version.projectId,
    renderKeys: [...new Set(boards.map((board) => board.renderKey))],
  })
  const byKey = new Map<string, Map<ArtifactThemeMode, ArtifactBoardPreviewRecord>>()
  for (const preview of stored) {
    const themes = byKey.get(preview.renderKey) ?? new Map()
    themes.set(preview.theme, preview)
    byKey.set(preview.renderKey, themes)
  }

  return new Map(boards.map((board) => [board.id, byKey.get(board.renderKey) ?? new Map()]))
}

/** The boards of a version still without a picture in one of its modes, in the canvas's order. */
export async function missingBoardPreviews(
  storage: Pick<ArtifactStorage, "listBoardPreviews">,
  version: ArtifactVersionRecord
): Promise<readonly MissingBoardPreview[]> {
  const { boards, themes } = previewedBoards(version)
  const stored = await boardPreviews(storage, version)

  return boards.flatMap((board) => {
    const missing = themes.filter((theme) => !stored.get(board.id)?.has(theme))
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
      const ready = themes.every((theme) => stored.get(board.id)?.has(theme))
      return [board.id, ready ? "ready" : waiting ? "pending" : "none"] as const
    })
  )
}

/**
 * Keeps pictures of a stored version's boards, each under its board's render key. Who may hand
 * them over is the caller's decision: only whoever rendered them with the author's data. Refuses
 * a board or a mode the version has no picture for, and anything but a stored PNG.
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

      const { file } = preview
      if (
        !isValidFileRef(file) ||
        file.mediaType !== "image/png" ||
        file.sizeBytes > MAX_BOARD_PREVIEW_BYTES
      ) {
        throw invalidPreview(
          `The picture of board '${preview.board}' must be a PNG of at most ${MAX_BOARD_PREVIEW_BYTES} bytes.`
        )
      }
      if (!(await statFileRef(context.blobStorage, file))) {
        throw invalidPreview(`The picture of board '${preview.board}' is not stored.`)
      }

      return { renderKey, theme: preview.theme, file: { ...file }, createdAt }
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
  options: { readonly delayMs?: number } = {}
): Promise<void> {
  if (version.outline.kind !== "canvas") return

  try {
    if ((await missingBoardPreviews(input.storage, version)).length === 0) return

    const queries = boardsReadLiveData(version)
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
