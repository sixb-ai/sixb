import { posix } from "node:path"
import type { BlobStorage, Sandbox } from "@sixb/core"
import { ARTIFACT_THEME_FILE, CANVAS_FILE, parseArtifactTheme } from "@sixb/core/artifacts"
import type { AgentRunMissingPreview } from "@sixb/core/internal/agents"
import {
  artifactQueryName,
  type BoardPreviewInput,
  MAX_BOARD_PREVIEW_BYTES,
  type MissingBoardPreview,
} from "@sixb/core/internal/artifacts/publish"
import type { ArtifactVersionRecord } from "@sixb/core/storage"
import { SANDBOX_CONTEXT_DIRECTORY } from "../run-sandbox"
import { readSandboxFile } from "../sandbox-files"
import type { AgentSandboxHandle } from "../sandbox-handle"
import { type CheckedPreview, type CheckedQuery, checkLayout } from "./layout-check/layout-check"
import { type PublishedArtifactFile, readArtifactVersionFiles } from "./materialize"

// The pictures of a canvas's boards, which the app shows until a reader opens a board. The layout
// check takes them as it checks each board; these read them out of the sandbox and store them as
// blobs, for the version's previews. The agent worker renders the same way in a sandbox of its
// own, for a version nobody rendered: one a person edited in the app.

const READ_TIMEOUT_MS = 30_000
/** How many pictures are read out of the sandbox at once. */
const READS = 8
/** Where the worker writes the version it renders, in its blank sandbox. */
const WORK_DIRECTORY = "canvas"

/**
 * The pictures the check took that `missing` asks for, each read out of the sandbox and stored in
 * `blobStorage`. A picture the check did not take is left out: the worker renders it later.
 */
export async function storeCheckedPreviews(input: {
  readonly handle: AgentSandboxHandle
  readonly checked: readonly CheckedPreview[]
  readonly missing: readonly AgentRunMissingPreview[]
  readonly blobStorage: Pick<BlobStorage, "put">
  readonly signal: AbortSignal
}): Promise<BoardPreviewInput[]> {
  const wanted = new Set(
    input.missing.flatMap(({ board, themes }) => themes.map((theme) => `${board}\0${theme}`))
  )
  const pictures = input.checked.filter(({ board, theme }) => wanted.has(`${board}\0${theme}`))

  const stored: BoardPreviewInput[] = []
  for (let start = 0; start < pictures.length; start += READS) {
    const batch = pictures.slice(start, start + READS)
    stored.push(
      ...(await Promise.all(
        batch.map(async ({ board, theme, path }) => {
          const bytes = await readSandboxFile(input.handle, {
            path,
            maxBytes: MAX_BOARD_PREVIEW_BYTES,
            signal: input.signal,
            timeoutMs: READ_TIMEOUT_MS,
          })
          const file = await input.blobStorage.put({
            body: bytes,
            expectedSizeBytes: bytes.byteLength,
            signal: input.signal,
            fileName: `${board}.${theme}.png`,
            mediaType: "image/png",
          })
          return { board, theme, file }
        })
      ))
    )
  }
  return stored
}

/**
 * Renders the pictures a stored canvas version's boards miss, in `sandbox`, a blank one created
 * for it: the version's files are written there, each missing board is opened in every mode it
 * misses, and the pictures are stored in `blobStorage`. What the boards' queries return, `queries`
 * holds as the version's publisher read them. Without them a board that reads a query is not
 * pictured: it would show its queries rejecting, which no reader sees. A sandbox without the
 * agent image's browser renders nothing.
 */
export async function renderBoardPreviews(input: {
  readonly sandbox: Sandbox
  readonly version: ArtifactVersionRecord
  readonly missing: readonly MissingBoardPreview[]
  readonly blobStorage: Pick<BlobStorage, "put" | "open" | "stat">
  readonly queries?: Readonly<Record<string, CheckedQuery>>
  readonly signal: AbortSignal
}): Promise<BoardPreviewInput[]> {
  const { sandbox, version, signal } = input
  if (input.missing.length === 0) return []

  const handle: AgentSandboxHandle = { sandbox, contextDirectory: SANDBOX_CONTEXT_DIRECTORY }
  const files = await readArtifactVersionFiles(input.blobStorage, version, signal)
  const bytesOf = (path: string) => files.find((file) => file.path === path)?.bytes

  const reading = input.queries ? undefined : boardsReadingQueries(files)
  const missing = input.missing.filter(({ board }) => !reading?.(board.file))
  if (missing.length === 0) return []

  const directory = posix.resolve(sandbox.workingDirectory, WORK_DIRECTORY)
  await sandbox.writeFiles(
    files
      .filter((file) => file.path !== CANVAS_FILE)
      .map((file) => ({ path: posix.join(directory, file.path), contents: file.bytes }))
  )

  const themeFile = bytesOf(ARTIFACT_THEME_FILE)
  const theme = themeFile ? parseArtifactTheme(new TextDecoder().decode(themeFile)) : null
  const check = await checkLayout({
    handle,
    layout: "canvas",
    boards: missing.flatMap(({ board }) => {
      const html = bytesOf(board.file)
      return html
        ? [{ id: board.id, file: board.file, w: board.w, h: board.h, html, pictured: true }]
        : []
    }),
    directory,
    files: files.map((file) => file.path),
    name: `${version.artifactId}-v${version.version}`,
    ...(theme && "theme" in theme ? { theme: theme.theme } : {}),
    ...(input.queries ? { queries: input.queries } : {}),
    signal,
  })
  if (check.status !== "checked") {
    console.warn(
      `[SixbAgent] The boards of version ${version.version} of '${version.artifactId}' were not pictured: ${check.reason}.`
    )
    return []
  }

  return storeCheckedPreviews({
    handle,
    checked: check.previews,
    missing: missing.map(({ board, themes }) => ({ board: board.id, themes })),
    blobStorage: input.blobStorage,
    signal,
  })
}

/**
 * Whether a board may read a query, for a version whose answers are not at hand: none when the
 * version holds no query; otherwise a board whose HTML names `query`, and every board once a
 * script beside them does, since which boards load it is not known. Erring on the side of reading
 * one only leaves a board its outline.
 */
function boardsReadingQueries(
  files: readonly PublishedArtifactFile[]
): ((boardFile: string) => boolean) | undefined {
  if (!files.some((file) => artifactQueryName(file.path) !== undefined)) return undefined

  const names = (file: PublishedArtifactFile) =>
    /\bquery\b/.test(new TextDecoder().decode(file.bytes))
  if (files.some((file) => SCRIPT.test(file.path) && names(file))) return () => true

  return (boardFile) => {
    const html = files.find((file) => file.path === boardFile)
    return html === undefined || names(html)
  }
}

const SCRIPT = /\.m?js$/i
