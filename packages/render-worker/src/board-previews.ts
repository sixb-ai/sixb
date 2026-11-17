import { posix } from "node:path"
import type { BlobStorage, FileRef, Sandbox } from "@sixb/core"
import {
  ARTIFACT_THEME_FILE,
  CANVAS_FILE,
  parseArtifactTheme,
  SMALL_BOARD_PREVIEW_WIDTH,
} from "@sixb/core/artifacts"
import {
  FRAME_DEFAULT_THEMES,
  injectFrameAssets,
  rewriteFrameReferences,
} from "@sixb/core/internal/artifacts/frames"
import {
  type ArtifactQueryAnswers,
  artifactQueryName,
  artifactThemeModes,
  BOARD_PREVIEW_JOB,
  BOARD_PREVIEW_MEDIA_TYPES,
  type BoardPreviewInput,
  MAX_BOARD_PREVIEW_BYTES,
  type MissingBoardPreview,
  missingBoardPreviews,
  parseArtifactQueryAnswers,
  type RefusedBoardPreview,
  storeBoardPreviews,
} from "@sixb/core/internal/artifacts/publish"
import type { ArtifactPreviewsRequestedQueueJob } from "@sixb/core/queues"
import type { ArtifactVersionRecord } from "@sixb/core/storage"
import type { RenderHost } from "./host"
import pictureScript from "./picture.cjs" with { type: "text" }
import {
  frameFile,
  inRenderSandbox,
  readBlob,
  readSandboxFiles,
  runScript,
  scriptFiles,
} from "./sandbox"

// The pictures of a canvas version's boards, which a reader sees until they open a board. The
// worker opens a blank sandbox of the project, which reaches only the CDNs a frame may load from,
// writes the version there with each board as its frame serves it, pictures what is missing there
// with the image's browser, keeps the pictures as the boards' previews, and destroys the sandbox.
// Boards that read queries read the answers the job carries: what the version's publisher could
// read when they published it.

/** Where the version is written in the sandbox, and where its pictures are taken. */
const SITE = "canvas"
const OUT = "pictures"
const SCRIPT = "picture.cjs"

/** The frame's own files, which a board's page loads from `__sixb/`. */
const KIT = ["__sixb/page.css", "__sixb/runtime.js"]
/** Of the time left once the version is written: the rest reads the pictures back and keeps them. */
const PICTURE_SHARE = 0.75
/** How many pictures are put in blob storage at once. */
const PUTS_AT_ONCE = 8

/**
 * Renders what a version's boards miss and keeps it as their previews. Repeating it renders
 * nothing more: what an earlier delivery kept is no longer missing. A project without sandboxes
 * renders nothing, and neither does a version deleted or whose content was written again since:
 * the write that asks for that content replaces this job with its own, and its own query answers.
 * A version created since holds the same content, and is rendered.
 */
export async function renderBoardPreviews(input: {
  readonly host: RenderHost
  readonly job: ArtifactPreviewsRequestedQueueJob
  readonly signal: AbortSignal
}): Promise<void> {
  const { host, job } = input
  const artifacts = host.storage.artifacts
  if (!artifacts || !host.sandboxes) return

  const { artifactId, version: number, updatedAt } = job.payload
  const version = await artifacts.getVersion({ projectId: host.id, artifactId, version: number })
  if (!version) return
  if (updatedAt !== undefined && version.updatedAt.getTime() !== Date.parse(updatedAt)) return

  const missing = await missingBoardPreviews(artifacts, version)
  if (missing.length === 0) return

  // What the boards' queries return, as the version's publisher read them when publishing.
  const queries = job.payload.queries
    ? await queryAnswers(host.blobStorage, job.payload.queries)
    : undefined

  const { previews, dropped, retry } = await inRenderSandbox(
    { sandboxes: host.sandboxes },
    `pictured '${artifactId}' version ${number}`,
    { timeoutMs: BOARD_PREVIEW_JOB.timeoutMs, signal: input.signal },
    (sandbox, left, signal) =>
      picture({
        sandbox,
        left,
        signal,
        version,
        missing,
        blobStorage: host.blobStorage,
        ...(queries ? { queries } : {}),
        lastAttempt: job.attempt >= BOARD_PREVIEW_JOB.attempts,
      })
  )
  const refused = await storeBoardPreviews(artifacts, version, previews)
  for (const { board, theme, size, reason } of [...dropped, ...refused]) {
    console.warn(
      `[SixbRenderWorker] The ${size} picture of board '${board}' of '${artifactId}' version ${number} in ${theme} mode was not kept: ${reason}.`
    )
  }
  if (retry) {
    throw new Error(
      `[SixbRenderWorker] Boards of '${artifactId}' version ${number} stopped answering: they are pictured again.`
    )
  }
}

/** What one picture the script took says of itself. */
interface Picture {
  readonly board: string
  readonly theme: BoardPreviewInput["theme"]
  readonly size: BoardPreviewInput["size"]
  readonly path: string
  readonly bytes: number
}

/**
 * Pictures the missing boards of the version in `sandbox`, in every mode each misses, and stores
 * each picture in `blobStorage`. Without query answers, a board that reads a query is not
 * pictured: it would show its queries rejecting, which no reader sees. Each picture stands alone:
 * one too large or that cannot be read or stored is dropped, and returned with why. When the
 * browser failed, or a board stopped answering, it throws, and the job tries again for what is
 * still missing; on its last attempt, what was pictured is kept.
 */
async function picture(input: {
  readonly sandbox: Sandbox
  readonly left: () => number
  readonly lastAttempt: boolean
  readonly version: ArtifactVersionRecord
  readonly missing: readonly MissingBoardPreview[]
  readonly blobStorage: RenderHost["blobStorage"]
  readonly queries?: ArtifactQueryAnswers
  readonly signal: AbortSignal
}): Promise<{
  readonly previews: readonly BoardPreviewInput[]
  readonly dropped: readonly RefusedBoardPreview[]
  /** A board stopped answering, which the job's next attempt pictures. */
  readonly retry?: true
}> {
  const { sandbox, version, signal } = input
  const files = await Promise.all(
    version.files.map(async (file) => ({
      path: file.path,
      bytes: await readBlob(input.blobStorage, file.file.blobId),
    }))
  )
  const bytesOf = (path: string) => files.find((file) => file.path === path)?.bytes

  const reading = input.queries ? undefined : boardsReadingQueries(files)
  const missing = input.missing.filter(({ board }) => !reading?.(board.file) && bytesOf(board.file))
  if (missing.length === 0) return { previews: [], dropped: [] }

  const site = posix.resolve(sandbox.workingDirectory, SITE)
  const out = posix.resolve(sandbox.workingDirectory, OUT)
  const boards = new Set(missing.map(({ board }) => board.file))
  const themeFile = bytesOf(ARTIFACT_THEME_FILE)
  const parsed = themeFile ? parseArtifactTheme(new TextDecoder().decode(themeFile)) : null
  const theme = parsed && "theme" in parsed ? parsed.theme : undefined
  // The modes the reader sees, each with the version's tokens over Sixb's.
  const themes = Object.fromEntries(
    artifactThemeModes(theme).map((mode) => {
      const base = FRAME_DEFAULT_THEMES[mode]
      return [mode, { ...base, tokens: { ...base.tokens, ...theme?.tokens } }]
    })
  )

  await sandbox.writeFiles([
    // Each board's page as its frame serves it: with the kit and the runtime.
    ...files
      .filter((file) => file.path !== CANVAS_FILE)
      .map((file) => ({
        path: posix.join(site, file.path),
        contents: boards.has(file.path)
          ? injectFrameAssets(
              rewriteFrameReferences(new TextDecoder().decode(file.bytes), [], file.path),
              "page",
              file.path
            )
          : file.bytes,
      })),
    ...KIT.map((path) => ({ path: posix.join(site, path), contents: frameFile(path) })),
    // What the boards' queries return, where the runtime reads them with no app around it.
    ...Object.entries(input.queries ?? {}).map(([name, answer]) => ({
      path: posix.join(site, "__sixb/queries", `${name}.json`),
      contents: JSON.stringify("error" in answer ? { error: answer.error } : answer.result),
    })),
    {
      path: posix.join(site, "__sixb/queries.json"),
      contents: JSON.stringify(
        Object.fromEntries(
          Object.entries(input.queries ?? {}).map(([name, answer]) => [
            name,
            "error" in answer ? 409 : 200,
          ])
        )
      ),
    },
    {
      path: posix.join(out, "boards.json"),
      contents: JSON.stringify(
        missing.map(({ board }) => ({
          id: board.id,
          file: board.file,
          w: board.w,
          h: board.h,
          smallWidth: SMALL_BOARD_PREVIEW_WIDTH,
        }))
      ),
    },
    { path: posix.join(out, "themes.json"), contents: JSON.stringify(themes) },
    ...scriptFiles(sandbox, SCRIPT, pictureScript),
  ])

  // Part of what is left to picture, so it reports what it took before the command is killed.
  const timeoutMs = input.left()
  const { report, stderr } = await runScript(
    sandbox,
    posix.resolve(sandbox.workingDirectory, SCRIPT),
    [site, out, Math.floor(timeoutMs * PICTURE_SHARE)],
    { timeoutMs, signal }
  )
  const name = `version ${version.version} of '${version.artifactId}'`
  if (report?.skipped) {
    console.warn(
      `[SixbRenderWorker] The boards of ${name} were not pictured: no ${report.skipped}.`
    )
    return { previews: [], dropped: [] }
  }
  if (!report || !Array.isArray(report.pictures)) {
    const why = String(report?.failed ?? (stderr || "the browser took no picture")).slice(0, 500)
    throw new Error(`[SixbRenderWorker] The boards of ${name} were not pictured: ${why}.`)
  }
  const said = (key: string) =>
    (Array.isArray(report[key]) ? report[key] : []) as { board: string; reason: string }[]
  for (const { board, reason } of said("unpictured")) {
    console.warn(`[SixbRenderWorker] Board '${board}' of ${name} was not pictured: ${reason}.`)
  }
  const stalls = said("stalls")
  for (const { board, reason } of stalls) {
    console.warn(`[SixbRenderWorker] Board '${board}' of ${name} stopped answering: ${reason}.`)
  }

  // Only the pictures asked for, where the script writes them.
  const wanted = new Set(
    missing.flatMap(({ board, themes }) => themes.map((mode) => `${board.id}\0${mode}`))
  )
  const pictures = (report.pictures as Picture[]).filter(
    ({ board, theme, path, bytes }) =>
      wanted.has(`${board}\0${theme}`) && path.startsWith(`${out}/`) && Number.isInteger(bytes)
  )
  const read = await readSandboxFiles(sandbox, pictures, {
    maxBytes: MAX_BOARD_PREVIEW_BYTES,
    signal,
  })

  const previews: BoardPreviewInput[] = []
  const dropped: RefusedBoardPreview[] = []
  const store = async (index: number) => {
    const { board, theme, size, path } = pictures[index] as Picture
    const bytes = read[index]
    if (!(bytes instanceof Uint8Array)) {
      const reason =
        bytes?.error === "too_large"
          ? `it is past the ${MAX_BOARD_PREVIEW_BYTES} bytes kept`
          : "it could not be read"
      dropped.push({ board, theme, size, reason })
      return
    }
    try {
      const file = await input.blobStorage.put({
        body: bytes,
        expectedSizeBytes: bytes.byteLength,
        signal,
        fileName: posix.basename(path),
        mediaType: BOARD_PREVIEW_MEDIA_TYPES[size],
      })
      previews.push({ board, theme, size, file })
    } catch (error) {
      if (signal.aborted) throw error
      console.warn(`[SixbRenderWorker] Could not store the picture '${path}':`, error)
      dropped.push({ board, theme, size, reason: "it could not be stored" })
    }
  }
  for (let at = 0; at < pictures.length; at += PUTS_AT_ONCE) {
    await Promise.all(pictures.slice(at, at + PUTS_AT_ONCE).map((_, offset) => store(at + offset)))
  }

  // A board that stopped answering, or one not reached in time, may be pictured next time: tried
  // again until the last attempt. What was pictured now is kept either way.
  if ((stalls.length > 0 || report.stopped === true) && !input.lastAttempt) {
    return { previews, dropped, retry: true }
  }
  return { previews, dropped }
}

/**
 * Whether a board may read a query, for a version whose answers are not at hand: none when the
 * version holds no query; otherwise a board whose HTML names `query`, and every board once a
 * script beside them does, since which boards load it is not known. Erring on the side of reading
 * one only leaves a board its outline.
 */
function boardsReadingQueries(
  files: readonly { readonly path: string; readonly bytes: Uint8Array }[]
): ((boardFile: string) => boolean) | undefined {
  if (!files.some((file) => artifactQueryName(file.path) !== undefined)) return undefined

  const names = (bytes: Uint8Array) => /\bquery\b/.test(new TextDecoder().decode(bytes))
  if (files.some((file) => /\.m?js$/i.test(file.path) && names(file.bytes))) return () => true

  return (boardFile) => {
    const html = files.find((file) => file.path === boardFile)
    return html === undefined || names(html.bytes)
  }
}

/**
 * The answers the job carries. Ones that cannot be read leave every query rejecting, as a reader
 * whose queries fail sees the boards.
 */
async function queryAnswers(
  blobStorage: Pick<BlobStorage, "open">,
  file: FileRef
): Promise<ArtifactQueryAnswers | undefined> {
  const answers = parseArtifactQueryAnswers(
    new TextDecoder().decode(await readBlob(blobStorage, file.blobId))
  )
  if (!answers)
    console.warn(`[SixbRenderWorker] The query answers in '${file.blobId}' are not answers.`)
  return answers ?? undefined
}
