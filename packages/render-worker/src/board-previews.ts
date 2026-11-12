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
import { kitFile, RENDER_NETWORK, readBlob, readSandboxFiles, runScript } from "./sandbox"

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

  const signal = AbortSignal.any([input.signal, AbortSignal.timeout(BOARD_PREVIEW_JOB.timeoutMs)])
  const sandbox = await host.sandboxes.create({ environment: {}, network: RENDER_NETWORK, signal })
  try {
    const { previews, dropped } = await picture({
      sandbox,
      version,
      missing,
      blobStorage: host.blobStorage,
      ...(queries ? { queries } : {}),
      signal,
    })
    const refused = await storeBoardPreviews(
      { storage: artifacts, blobStorage: host.blobStorage },
      version,
      previews
    )
    for (const { board, theme, size, reason } of [...dropped, ...refused]) {
      console.warn(
        `[SixbRenderWorker] The ${size} picture of board '${board}' of '${artifactId}' version ${number} in ${theme} mode was not kept: ${reason}.`
      )
    }
  } finally {
    await sandbox.destroy().catch((error: unknown) => {
      console.error(
        `[SixbRenderWorker] Could not destroy the sandbox that pictured '${artifactId}' version ${number}:`,
        error
      )
    })
  }
}

/** What one picture the script took says of itself. */
interface Picture {
  readonly board: string
  readonly theme: BoardPreviewInput["theme"]
  readonly size: BoardPreviewInput["size"]
  readonly path: string
  readonly bytes?: number
}

/**
 * Pictures the missing boards of the version in `sandbox`, in every mode each misses, and stores
 * each picture in `blobStorage`. Without query answers, a board that reads a query is not
 * pictured: it would show its queries rejecting, which no reader sees. Each picture stands alone:
 * one too large or that cannot be read or stored is dropped, and returned with why.
 */
async function picture(input: {
  readonly sandbox: Sandbox
  readonly version: ArtifactVersionRecord
  readonly missing: readonly MissingBoardPreview[]
  readonly blobStorage: RenderHost["blobStorage"]
  readonly queries?: ArtifactQueryAnswers
  readonly signal: AbortSignal
}): Promise<{
  readonly previews: readonly BoardPreviewInput[]
  readonly dropped: readonly RefusedBoardPreview[]
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
  const script = posix.resolve(sandbox.workingDirectory, SCRIPT)
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
    ...KIT.map((path) => ({ path: posix.join(site, path), contents: kitFile(path) })),
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
    { path: script, contents: pictureScript },
  ])

  // Most of its time to picture, so it reports what it took before the command is killed.
  const deadlineMs = Math.floor((BOARD_PREVIEW_JOB.timeoutMs * 4) / 5)
  const { report, stderr } = await runScript(sandbox, script, [site, out, deadlineMs], {
    timeoutMs: BOARD_PREVIEW_JOB.timeoutMs,
    signal,
  })
  if (!report || !Array.isArray(report.pictures)) {
    const why = report?.skipped ?? report?.failed ?? (stderr || "the browser took no picture")
    console.warn(
      `[SixbRenderWorker] The boards of version ${version.version} of '${version.artifactId}' were not pictured: ${String(why).slice(0, 500)}.`
    )
    return { previews: [], dropped: [] }
  }
  for (const { board, reason } of (report.unpictured ?? []) as {
    board: string
    reason: string
  }[]) {
    console.warn(
      `[SixbRenderWorker] Board '${board}' of '${version.artifactId}' was not pictured: ${reason.slice(0, 200)}.`
    )
  }

  // Only the pictures asked for, where the script writes them.
  const wanted = new Set(
    missing.flatMap(({ board, themes }) => themes.map((mode) => `${board.id}\0${mode}`))
  )
  const pictures = (report.pictures as Picture[]).filter(
    ({ board, theme, path }) => wanted.has(`${board}\0${theme}`) && path.startsWith(`${out}/`)
  )
  const read = await readSandboxFiles(sandbox, sandbox.workingDirectory, pictures, {
    maxBytes: MAX_BOARD_PREVIEW_BYTES,
    signal,
  })

  const previews: BoardPreviewInput[] = []
  const dropped: RefusedBoardPreview[] = []
  for (const [index, { board, theme, size, path }] of pictures.entries()) {
    const bytes = read[index]
    if (!bytes || !(bytes instanceof Uint8Array)) {
      const reason =
        bytes && "error" in bytes && bytes.error === "too_large"
          ? `it is past the ${MAX_BOARD_PREVIEW_BYTES} bytes kept`
          : "it could not be read"
      dropped.push({ board, theme, size, reason })
      continue
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
