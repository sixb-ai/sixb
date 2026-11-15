import { createHash } from "node:crypto"
import type { Principal } from "../../auth"
import type { BlobStorage, FileRef } from "../../blob-storage/types"
import { isValidFileRef } from "../../blob-storage/validation"
import type { Queue, RenderQueueJob } from "../../queues"
import type {
  ArtifactBoardPreviewRecord,
  ArtifactBoardPreviewSize,
  ArtifactFile,
  ArtifactStorage,
  ArtifactVersionRecord,
} from "../../storage/artifacts/types"
import { CANVAS_FILE } from "../canvas"
import { BOARD_PREVIEW_JOB, BOARD_PREVIEW_WAIT_MS } from "../canvas-display"
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
// The render worker renders what a version's boards miss, in a blank sandbox, however the version
// was published. A board runs with the data its version's publisher could see: never more.

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
 * themes it runs in, and its artifact. `theme.json` is one of the files, so the modes and tokens it
 * sets are in the key too.
 *
 * Naming the artifact keeps each artifact's pictures its own: whoever may hand over a picture for
 * one may already change its boards, but not another's. Who saves the version does not count: a
 * person moving a note, or an Agent turn someone else asked for, keeps the pictures of the boards
 * it left as they were.
 *
 * When the version holds queries the picture shows its author's data: the key names the author
 * too, so a version saved by someone else renders their data, not the previous author's.
 */
export function boardRenderKey(input: {
  readonly board: Pick<CanvasOutlineBoard, "file" | "w" | "h">
  readonly files: readonly ArtifactFile[]
  /** Every board's HTML file in the version: the others are not this board's to load. */
  readonly boardFiles: ReadonlySet<string>
  readonly author: Principal
  readonly artifactId: string
}): string {
  const { board, files, boardFiles, author, artifactId } = input

  const loaded = files
    .filter(
      (entry) =>
        entry.path !== CANVAS_FILE && (entry.path === board.file || !boardFiles.has(entry.path))
    )
    .map((entry) => [entry.path, entry.file.digest] as const)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))

  const reader = boardsReadLiveData({ files }) ? [author.type, author.id] : null

  return createHash("sha256")
    .update(
      JSON.stringify([
        RENDER_KEY_FORMAT,
        frameKitDigest(),
        board.file,
        board.w,
        board.h,
        artifactId,
        reader,
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
 * What a copy of an artifact, such as a forked conversation's, does with its canvases' pictures.
 * Each board is named anew for the copy. A board kept from a static version keeps the source's
 * pictures under its new name: it is the same page. A board that shows its author's data gets
 * none, and runs live for the copy's readers.
 */
export function boardPreviewsOfCopy(copyId: string): {
  /** The outline each copied version takes; see `CopyArtifactInput.outlineOf`. */
  readonly outlineOf: (version: ArtifactVersionRecord) => ArtifactOutline | undefined
  /** Keeps the static boards' pictures under their new names, once the copy is stored. */
  readonly carry: (
    storage: Pick<ArtifactStorage, "listBoardPreviews" | "putBoardPreviews">,
    projectId: string
  ) => Promise<void>
} {
  const renamed = new Map<string, string>()

  const outlineOf = (version: ArtifactVersionRecord): ArtifactOutline | undefined => {
    if (version.outline.kind !== "canvas") return undefined

    const copied = withBoardRenderKeys(version, copyId)
    if (boardsReadLiveData(version)) return copied.outline

    const source = new Map(previewedBoards(version).boards.map((each) => [each.id, each.renderKey]))
    for (const board of previewedBoards(copied).boards) {
      const from = source.get(board.id)
      if (from) renamed.set(from, board.renderKey)
    }

    return copied.outline
  }

  const carry = async (
    storage: Pick<ArtifactStorage, "listBoardPreviews" | "putBoardPreviews">,
    projectId: string
  ) => {
    if (renamed.size === 0) return

    const pictures = await storage.listBoardPreviews({ projectId, renderKeys: [...renamed.keys()] })
    const previews = pictures.flatMap((picture) => {
      const renderKey = renamed.get(picture.renderKey)
      return renderKey ? [{ ...picture, renderKey }] : []
    })

    if (previews.length > 0) await storage.putBoardPreviews({ projectId, previews })
  }

  return { outlineOf, carry }
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
 * before pictures, or one written longer ago than the wait.
 */
export async function boardPreviewStatuses(
  storage: Pick<ArtifactStorage, "listBoardPreviews">,
  version: ArtifactVersionRecord,
  input: { readonly renders: boolean; readonly now: Date }
): Promise<ReadonlyMap<string, BoardPreviewStatus>> {
  const { boards, themes } = previewedBoards(version)
  const stored = await boardPreviews(storage, version)
  const waiting =
    input.renders && input.now.getTime() - version.updatedAt.getTime() < BOARD_PREVIEW_WAIT_MS

  return new Map(
    boards.map((board) => {
      const ready = themes.every((theme) => pictured(stored.get(board.id), theme))
      return [board.id, ready ? "ready" : waiting ? "pending" : "none"] as const
    })
  )
}

/** A picture that was not kept, and why, in words for whoever handed it over. */
export interface RefusedBoardPreview {
  readonly board: string
  readonly theme: ArtifactThemeMode
  readonly size: ArtifactBoardPreviewSize
  readonly reason: string
}

/**
 * Keeps pictures of a stored version's boards, each under its board's render key, as the render
 * worker stored them. Each picture stands alone: one for a board or a mode the version has no
 * picture for, in another format than its size's, or past the size limit, is left out and
 * returned, and the others are kept.
 */
export async function storeBoardPreviews(
  storage: Pick<ArtifactStorage, "putBoardPreviews">,
  version: ArtifactVersionRecord,
  previews: readonly BoardPreviewInput[]
): Promise<readonly RefusedBoardPreview[]> {
  if (previews.length === 0) return []

  const { boards, themes } = previewedBoards(version)
  const keys = new Map(boards.map((board) => [board.id, board.renderKey]))
  const createdAt = new Date()

  const checked = previews.map(
    (
      preview
    ):
      | { readonly record: Omit<ArtifactBoardPreviewRecord, "projectId"> }
      | { readonly refused: RefusedBoardPreview } => {
      const { board, theme, size, file } = preview
      const refuse = (reason: string) => ({ refused: { board, theme, size, reason } })

      const renderKey = keys.get(board)
      if (!renderKey || !themes.includes(theme)) {
        return refuse(`the version has no board '${board}' to picture in ${theme} mode`)
      }

      const mediaType = SIZES.includes(size) ? BOARD_PREVIEW_MEDIA_TYPES[size] : undefined
      if (!mediaType || !isValidFileRef(file) || file.mediaType !== mediaType) {
        return refuse(`a ${size} picture must be ${mediaType ?? "full or small"}`)
      }
      if (file.sizeBytes > MAX_BOARD_PREVIEW_BYTES) {
        return refuse(`it is ${file.sizeBytes} bytes, past the ${MAX_BOARD_PREVIEW_BYTES} kept`)
      }

      return { record: { renderKey, theme, size, file: { ...file }, createdAt } }
    }
  )

  const records = checked.flatMap((each) => ("record" in each ? [each.record] : []))
  if (records.length > 0) {
    await storage.putBoardPreviews({ projectId: version.projectId, previews: records })
  }

  return checked.flatMap((each) => ("refused" in each ? [each.refused] : []))
}

/**
 * One job per artifact. Each write that asks replaces the job still waiting, so a canvas edited
 * live, written back every few seconds, waits for one job, which renders its latest revision once
 * it rests, never each state it went through.
 */
export function boardPreviewsJobId(artifactId: string): string {
  return `art_previews_${artifactId}`
}

/**
 * Asks the render worker to render what a stored version's boards still miss, once the canvas
 * rests, `BOARD_PREVIEW_JOB.settleMs` from now, in the artifact's one job: it takes the place of
 * any asked for an earlier revision. Nothing is asked when nothing is missing.
 *
 * Boards that read queries show their author's data, so the version's queries are answered now,
 * by `query`, as whoever just published it, and the job carries the answers: kept as a blob only
 * the job names. A query that fails is answered as its rejection. Only the write that asks last
 * has its answers rendered: those of a job it replaced are never read.
 *
 * The version exists by now and its pictures are derived from it, so a request that fails is
 * reported, not thrown: the publish succeeded, and the viewer shows the boards' outlines instead.
 */
export async function requestBoardPreviews(
  input: {
    readonly storage: Pick<ArtifactStorage, "listBoardPreviews">
    readonly queue: Pick<Queue<RenderQueueJob>, "enqueue">
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
          id: boardPreviewsJobId(version.artifactId),
          replace: true,
          type: "artifact.previews.requested",
          payload: {
            artifactId: version.artifactId,
            version: version.version,
            updatedAt: version.updatedAt.toISOString(),
            ...(queries ? { queries } : {}),
          },
          availableAt: new Date(Date.now() + BOARD_PREVIEW_JOB.settleMs).toISOString(),
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
    fileName: `${version.artifactId}-r${version.revision}-queries.json`,
    mediaType: "application/json",
  })
}

let kitDigest: string | undefined

/** What a page runs with besides its own files: a new kit renders it anew. */
export function frameKitDigest(): string {
  kitDigest ??= createHash("sha256")
    .update(JSON.stringify([FRAME_ASSETS, FRAME_DEFAULT_THEMES]))
    .digest("hex")
  return kitDigest
}
