import { createHash } from "node:crypto"
import { posix } from "node:path"
import type { BlobStorage } from "@sixb/core"
import { AgentToolPublicError } from "@sixb/core"
import { inferFileMediaType } from "@sixb/core/internal/blob-storage"
import { createSixbError, withFailureMessage } from "@sixb/core/internal/errors"
import type { SubagentRunFile } from "@sixb/core/storage"
import { NEVER_ABORTED_SIGNAL, waitForAbort } from "./abort"
import { readBlob } from "./artifacts/materialize"
import { type PreparedAgentAttachmentContext, SANDBOX_ATTACHMENT_LIMITS } from "./attachments"
import {
  listSandboxFiles,
  readSandboxFile,
  resolveSandboxPath,
  type SandboxFileEntry,
  SandboxFileError,
  type SandboxFileListing,
} from "./sandbox-files"
import type { AgentSandboxHandle } from "./sandbox-handle"
import type { AgentFileBudget } from "./tools/tool-files"

// A parent Agent hands its child files from its sandbox, and gets back what the child wrote under
// `out/`. Both go through blob storage: the parent stores what it hands over in the child's spec,
// the child stores its outputs in its result, and each side copies them into its own sandbox.

/** Where a child writes the files its parent gets back, relative to its working directory. */
const CHILD_OUTPUT_DIRECTORY = "out"

/**
 * Where a parent finds them, a directory per spawn key. Under `.sixb/agent`, so they last for the
 * turn, like the run's attachments and artifacts.
 */
export const CHILD_FILES_DIRECTORY = ".sixb/agent/children"

/** What a run installs under `.sixb/agent` that holds files worth handing over. */
const HANDED_RUN_DIRECTORIES = ["attachments", "artifacts", "tool-files", "children"].map(
  (directory) => `.sixb/agent/${directory}/`
)
const SANDBOX_TIMEOUT_MS = 30_000
const { maxFiles, fileMaxBytes, totalMaxBytes } = SANDBOX_ATTACHMENT_LIMITS

/** What a run's framework tools share of its environment, to hand files over. */
export interface AgentRunWorkspace {
  readonly sandbox: () => Promise<AgentSandboxHandle>
  readonly blobStorage: BlobStorage
  /** Shared with every other file the run stores. */
  readonly budget: AgentFileBudget
  /**
   * Install the latest version of what these runs published in the thread, in the run's
   * `$SIXB_ARTIFACTS`. Absent when the run installs no artifacts.
   */
  readonly installArtifactsFrom?: (runIds: readonly string[], signal: AbortSignal) => Promise<void>
}

/** A file in a sandbox, as `wait_agent` lists it. */
export interface ListedChildFile {
  /** Relative to the working directory. */
  readonly path: string
  readonly sizeBytes: number
  readonly mediaType?: string
}

interface Source {
  /** Relative to the working directory. */
  readonly path: string
  readonly absolutePath: string
  readonly sizeBytes?: number
}

/**
 * Store the files and directories a parent hands its child, each at its path relative to the
 * working directory. Refused before the child is admitted when a path is missing, leaves the
 * working directory or is the run's own context, or when the files pass the attachment limits.
 * The bytes count against the parent's run budget: `release` them when no child is admitted.
 */
export async function storeHandedFiles(input: {
  readonly workspace: AgentRunWorkspace
  readonly paths: readonly string[]
  readonly signal: AbortSignal
}): Promise<{ readonly files: readonly SubagentRunFile[]; release(): void }> {
  const { workspace, signal } = input
  const handle = await workspace.sandbox()
  signal.throwIfAborted()

  const sources = new Map<string, Source>()
  for (const path of input.paths) {
    for (const source of await listHandedSources(handle, path, signal)) {
      sources.set(source.path, source)
    }
  }
  if (sources.size > maxFiles) {
    throw handOffError(
      `${sources.size} files; a child receives at most ${maxFiles}. Hand over fewer files or a smaller directory`
    )
  }
  assertWithinTotal([...sources.values()].reduce((sum, source) => sum + (source.sizeBytes ?? 0), 0))

  const reservation = workspace.budget.reserve(0, "spawn_agent")
  try {
    const files: SubagentRunFile[] = []
    let totalBytes = 0
    for (const source of sources.values()) {
      if (source.sizeBytes !== undefined && source.sizeBytes > fileMaxBytes) {
        throw fileTooLarge(source.path)
      }

      const bytes = await readSandboxFile(handle, {
        path: source.absolutePath,
        maxBytes: fileMaxBytes,
        signal,
        timeoutMs: SANDBOX_TIMEOUT_MS,
      }).catch((error: unknown) => {
        throw toHandOffError(error, source.path)
      })
      if (bytes.byteLength > fileMaxBytes) throw fileTooLarge(source.path)

      totalBytes += bytes.byteLength
      assertWithinTotal(totalBytes)

      files.push({
        path: source.path,
        fileRef: await storeFile(workspace, reservation, bytes, source.path, signal),
      })
    }
    return { files, release: () => reservation.release() }
  } catch (error) {
    reservation.release()
    throw error
  }
}

/**
 * The child's side: the files its parent handed over, at the same paths in its sandbox, listed in
 * `$SIXB_ATTACHMENTS` and readable with `view_file`.
 */
export async function prepareHandedFiles(input: {
  readonly projectId: string
  readonly parentRunId: string
  readonly files: readonly SubagentRunFile[]
  readonly blobStorage: BlobStorage
  readonly signal?: AbortSignal
}): Promise<PreparedAgentAttachmentContext> {
  const signal = input.signal ?? NEVER_ABORTED_SIGNAL
  const sandboxFiles: PreparedAgentAttachmentContext["sandboxFiles"][number][] = []

  for (const { path, fileRef } of input.files) {
    const stat = await waitForAbort(input.blobStorage.stat(fileRef.blobId), signal)
    if (stat?.digest !== fileRef.digest) {
      throw new Error(
        `[SixbAgentWorker] '${path}', handed over by parent run '${input.parentRunId}', is no longer in blob storage.`
      )
    }
    sandboxFiles.push({
      key: path,
      path,
      bytes: await readBlob(input.blobStorage, fileRef.blobId, signal),
      fileRef,
    })
  }

  return {
    entries: [],
    promptTextByPartKey: new Map(),
    modelFileDataByPartKey: new Map(),
    sandboxFiles,
    manifestJson: JSON.stringify(
      {
        projectId: input.projectId,
        parentRunId: input.parentRunId,
        attachments: input.files.map(({ path, fileRef }) => ({
          key: path,
          fileName: posix.basename(path),
          ...(fileRef.mediaType === undefined ? {} : { mediaType: fileRef.mediaType }),
          sizeBytes: fileRef.sizeBytes,
          digest: fileRef.digest,
          sandboxPath: path,
          source: "parent",
        })),
      },
      null,
      2
    ),
  }
}

/**
 * Store what a child that finished wrote under `out/`, by path relative to it. A file its parent
 * handed over there and the child left unchanged does not come back. Past the attachment limits
 * the child fails, saying so, rather than return some of its files as if they were all.
 */
export async function storeChildOutputs(input: {
  readonly workspace: AgentRunWorkspace
  readonly handed: readonly SubagentRunFile[]
  readonly runId: string
  readonly parentRunId: string
  readonly signal: AbortSignal
}): Promise<readonly SubagentRunFile[]> {
  const { workspace, signal } = input
  const handle = await workspace.sandbox()
  const directory = posix.join(handle.sandbox.workingDirectory, CHILD_OUTPUT_DIRECTORY)
  const listing = await listSandboxFiles(handle, {
    directory,
    maxFiles: maxFiles + input.handed.length + 1,
    signal,
    timeoutMs: SANDBOX_TIMEOUT_MS,
  })

  // A file of the size of one handed over at its path may be that file: only its bytes tell.
  const handed = new Map(input.handed.map((file) => [file.path, file.fileRef]))
  const handedAt = (path: string) => handed.get(posix.join(CHILD_OUTPUT_DIRECTORY, path))
  const maybeHanded = (file: SandboxFileEntry) =>
    handedAt(file.relativePath)?.sizeBytes === file.sizeBytes
  const assertWithinLimits = (files: readonly SandboxFileEntry[], truncated = false) => {
    if (truncated || files.length > maxFiles) {
      throw childOutputError(input, `It left more than ${maxFiles} files in out/`)
    }
    const tooLarge = files.find((file) => file.sizeBytes > fileMaxBytes)
    if (tooLarge) {
      throw childOutputError(
        input,
        `'out/${tooLarge.relativePath}' holds more than ${formatFileSize(fileMaxBytes)}`
      )
    }
    if (files.reduce((sum, file) => sum + file.sizeBytes, 0) > totalMaxBytes) {
      throw childOutputError(
        input,
        `Its files in out/ hold more than ${formatFileSize(totalMaxBytes)} in all`
      )
    }
  }

  // Checked before reading anything: these files come back whatever their bytes.
  assertWithinLimits(
    listing.files.filter((file) => !maybeHanded(file)),
    listing.truncated
  )

  const reservation = workspace.budget.reserve(0, "spawn_agent")
  try {
    const kept: { readonly entry: SandboxFileEntry; readonly bytes: Uint8Array }[] = []
    for (const entry of listing.files) {
      const bytes = await readSandboxFile(handle, {
        path: posix.join(directory, entry.relativePath),
        maxBytes: fileMaxBytes,
        signal,
        timeoutMs: SANDBOX_TIMEOUT_MS,
      })
      if (handedAt(entry.relativePath)?.digest === `sha256:${sha256(bytes)}`) continue

      kept.push({ entry: { relativePath: entry.relativePath, sizeBytes: bytes.byteLength }, bytes })
    }
    assertWithinLimits(kept.map((file) => file.entry))

    const files: SubagentRunFile[] = []
    for (const { entry, bytes } of kept) {
      files.push({
        path: entry.relativePath,
        fileRef: await storeFile(workspace, reservation, bytes, entry.relativePath, signal),
      })
    }
    return files
  } catch (error) {
    reservation.release()
    throw error
  }
}

/**
 * The parent's side: copy what a child wrote under `out/` into the parent's sandbox, under
 * `.sixb/agent/children/<key>/`, and list it there.
 */
export async function installChildOutputs(input: {
  readonly workspace: AgentRunWorkspace
  readonly key: string
  readonly files: readonly SubagentRunFile[]
  readonly signal: AbortSignal
}): Promise<readonly ListedChildFile[]> {
  const { workspace, signal } = input
  const handle = await workspace.sandbox()
  const directory = posix.join(CHILD_FILES_DIRECTORY, childDirectoryName(input.key))

  const records = []
  for (const { path, fileRef } of input.files) {
    records.push({
      path: posix.join(handle.sandbox.workingDirectory, directory, path),
      contents: await readBlob(workspace.blobStorage, fileRef.blobId, signal),
    })
  }
  signal.throwIfAborted()
  await handle.sandbox.writeFiles(records)

  return input.files.map(({ path, fileRef }) => ({
    path: posix.join(directory, path),
    sizeBytes: fileRef.sizeBytes,
    ...(fileRef.mediaType === undefined ? {} : { mediaType: fileRef.mediaType }),
  }))
}

/** A spawn key as one path segment; one that needs changing gets a hash, so two never collide. */
function childDirectoryName(key: string): string {
  if (/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(key)) return key

  const safe = key.replace(/[^A-Za-z0-9._-]/g, "_").replace(/^[._-]+/, "")
  return `${safe.slice(0, 96) || "child"}-${sha256(new TextEncoder().encode(key)).slice(0, 8)}`
}

async function listHandedSources(
  handle: AgentSandboxHandle,
  path: string,
  signal: AbortSignal
): Promise<readonly Source[]> {
  const root = handle.sandbox.workingDirectory
  let absolutePath: string
  try {
    absolutePath = resolveSandboxPath(root, path)
  } catch (error) {
    throw toHandOffError(error, path)
  }
  const relativePath = posix.relative(posix.resolve(root), absolutePath)
  assertHandable(relativePath, path)

  let listing: SandboxFileListing
  try {
    listing = await listSandboxFiles(handle, {
      directory: absolutePath,
      maxFiles: maxFiles + 1,
      signal,
      timeoutMs: SANDBOX_TIMEOUT_MS,
    })
  } catch (error) {
    throw toHandOffError(error, path)
  }

  if (listing.truncated) {
    throw handOffError(
      `'${path}': it holds more than ${maxFiles} files; a child receives at most ${maxFiles}`
    )
  }
  if (listing.files.length === 0) {
    if (listing.directory) throw handOffError(`'${path}': it is an empty directory`)
    // A missing path lists nothing as well; reading it says which.
    return [{ path: relativePath, absolutePath }]
  }

  return listing.files.map((file) => {
    const filePath = posix.join(relativePath, file.relativePath)
    assertHandable(filePath, path)
    return {
      path: filePath,
      absolutePath: posix.join(absolutePath, file.relativePath),
      sizeBytes: file.sizeBytes,
    }
  })
}

/** The run's own context under `.sixb/agent` stays its own: it holds the run's API address. */
function assertHandable(relativePath: string, requested: string): void {
  const runFile = relativePath === ".sixb/agent" || relativePath.startsWith(".sixb/agent/")
  const handed = HANDED_RUN_DIRECTORIES.some((directory) =>
    `${relativePath}/`.startsWith(directory)
  )
  if (!runFile || handed) {
    return
  }

  throw handOffError(
    `'${requested}': it is part of the run context Sixb installs under .sixb/agent. Hand over files from your working directory, $SIXB_ATTACHMENT_DIR, $SIXB_ARTIFACTS_DIR or ${CHILD_FILES_DIRECTORY}`
  )
}

async function storeFile(
  workspace: AgentRunWorkspace,
  reservation: ReturnType<AgentFileBudget["reserve"]>,
  bytes: Uint8Array,
  path: string,
  signal: AbortSignal
) {
  // Blob storage keeps identical bytes once: a file handed to several children counts once.
  reservation.addContent(sha256(bytes), bytes.byteLength)
  const fileName = posix.basename(path)
  return workspace.blobStorage.put({
    body: bytes,
    expectedSizeBytes: bytes.byteLength,
    signal,
    fileName,
    mediaType: inferFileMediaType(fileName, bytes),
  })
}

function assertWithinTotal(totalBytes: number): void {
  if (totalBytes <= totalMaxBytes) return

  const limit = formatFileSize(totalMaxBytes)
  throw handOffError(`more than ${limit}; a child receives at most ${limit} in all`)
}

function fileTooLarge(path: string): AgentToolPublicError {
  return handOffError(
    `'${path}': it holds more than ${formatFileSize(fileMaxBytes)}, the most a file handed to a child may hold`
  )
}

function toHandOffError(error: unknown, path: string): unknown {
  if (!(error instanceof SandboxFileError)) return error
  if (error.reason === "too_large") return fileTooLarge(path)
  return handOffError(`'${path}': ${error.message}`)
}

function handOffError(problem: string): AgentToolPublicError {
  return new AgentToolPublicError(`[SixbAgentWorker] spawn_agent cannot hand over ${problem}.`)
}

function childOutputError(
  run: { readonly runId: string; readonly parentRunId: string },
  problem: string
): Error {
  const message = `${problem}; at most ${maxFiles} files of ${formatFileSize(fileMaxBytes)}, ${formatFileSize(totalMaxBytes)} in all, come back to its parent. Spawn it again with a task that writes fewer or smaller files to out/.`
  return withFailureMessage(
    createSixbError(
      "agent.execution_failed",
      `[SixbAgentWorker] Subagent run '${run.runId}' could not return its files. ${message}`,
      { details: { parentRunId: run.parentRunId, runId: run.runId } }
    ),
    `The subagent could not return its files. ${message}`
  )
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex")
}

export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} bytes`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${Math.round((bytes / (1024 * 1024)) * 10) / 10} MB`
}
