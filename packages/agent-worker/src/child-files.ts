import { createHash } from "node:crypto"
import { posix } from "node:path"
import type { BlobStorage, FileRef } from "@sixb/core"
import { AgentToolPublicError } from "@sixb/core"
import { inferFileMediaType } from "@sixb/core/internal/blob-storage"
import type { SubagentRunFile } from "@sixb/core/storage"
import { NEVER_ABORTED_SIGNAL, waitForAbort } from "./abort"
import { readBlob } from "./artifacts/materialize"
import {
  formatBytes,
  type PreparedAgentAttachmentContext,
  SANDBOX_ATTACHMENT_LIMITS,
} from "./attachments"
import {
  listSandboxFiles,
  readSandboxFile,
  resolveSandboxEntry,
  resolveSandboxPath,
  type SandboxFileEntry,
  SandboxFileError,
  type SandboxFileListing,
} from "./sandbox-files"
import { type AgentSandboxHandle, contextPath } from "./sandbox-handle"
import { AgentFileBudget } from "./tools/tool-files"
import type { AgentRunFiles } from "./types"

// A parent Agent hands its child files from its sandbox, and gets back what the child wrote under
// `out/`. Both go through blob storage: the parent stores what it hands over in the child's spec,
// the child stores its outputs in its result, and each side copies them into its own sandbox.

/** Where a child writes the files its parent gets back, relative to its working directory. */
const CHILD_OUTPUT_DIRECTORY = "out"

/**
 * Where a parent finds them, a directory per spawn key, in the context directory. They last for
 * the turn, like the run's attachments and artifacts.
 */
export const CHILD_FILES_DIRECTORY = "children"

/** What a run installs in its context directory that holds files worth handing over. */
const HANDED_RUN_DIRECTORIES = ["attachments", "artifacts", "tool-files", CHILD_FILES_DIRECTORY]
const SANDBOX_TIMEOUT_MS = 30_000
const { maxFiles, fileMaxBytes, totalMaxBytes } = SANDBOX_ATTACHMENT_LIMITS

/**
 * Whether `path` is in the run's context directory, both relative to the working directory. A
 * context directory outside the working directory holds no such path.
 */
function isRunFile(path: string, contextDirectory: string): boolean {
  return path === contextDirectory || path.startsWith(`${contextDirectory}/`)
}

/** A file a child returned, copied into its parent's sandbox for the turn. */
export interface InstalledChildFile extends SubagentRunFile {
  /** As the agent names it: relative to the working directory, or absolute. */
  readonly sandboxPath: string
}

/** A file a parent hands its child, checked but not read yet. */
export interface HandedSource {
  /** Where the child finds it: the path the parent named, relative to the working directory. */
  readonly path: string
  /** Where it really is, every symbolic link followed. */
  readonly absolutePath: string
  readonly sizeBytes?: number
}

/**
 * Check the files and directories a parent hands its child, without reading them. Refused when a
 * path is missing or a link, leaves the working directory or really is the run's own context, or
 * when the files pass the attachment limits.
 */
export async function listHandedSources(input: {
  readonly files: AgentRunFiles
  readonly paths: readonly string[]
  readonly signal: AbortSignal
}): Promise<readonly HandedSource[]> {
  const handle = await input.files.sandbox()
  input.signal.throwIfAborted()

  // The working directory may itself be reached through a link: compare real paths with its own.
  const root = posix.resolve(handle.sandbox.workingDirectory)
  const rootEntry = await resolveSandboxEntry(handle, {
    path: root,
    signal: input.signal,
    timeoutMs: SANDBOX_TIMEOUT_MS,
  })
  const realRoot = rootEntry.kind === "directory" ? rootEntry.realPath : root

  const sources = new Map<string, HandedSource>()
  for (const path of input.paths) {
    for (const source of await handedSourcesAt(handle, realRoot, path, input.signal)) {
      sources.set(source.path, source)
    }
  }
  if (sources.size > maxFiles) {
    throw handOffError(
      `${sources.size} files; a child receives at most ${maxFiles}. Hand over fewer files or a smaller directory`
    )
  }
  assertWithinTotal([...sources.values()].reduce((sum, source) => sum + (source.sizeBytes ?? 0), 0))
  return [...sources.values()]
}

/**
 * Read and store the files a parent hands its child once it will be admitted, one at a time,
 * against the parent's run budget: `release` them when it is not.
 */
export async function storeHandedFiles(input: {
  readonly files: AgentRunFiles
  readonly sources: readonly HandedSource[]
  readonly signal: AbortSignal
}): Promise<{ readonly files: readonly SubagentRunFile[]; release(): void }> {
  const reservation = input.files.budget.reserve(0, "spawn_agent")
  try {
    const stored: SubagentRunFile[] = []
    await readHandedSources(input, async (source, bytes) => {
      const fileRef = await storeFile(input.files, reservation, bytes, source.path, input.signal)
      stored.push({ path: source.path, fileRef })
    })
    return { files: stored, release: () => reservation.release() }
  } catch (error) {
    reservation.release()
    throw error
  }
}

/** The references the files would be stored under, read one at a time and stored nowhere. */
export async function handedFileRefs(input: {
  readonly files: AgentRunFiles
  readonly sources: readonly HandedSource[]
  readonly signal: AbortSignal
}): Promise<readonly SubagentRunFile[]> {
  const refs: SubagentRunFile[] = []
  await readHandedSources(input, async (source, bytes) => {
    refs.push({ path: source.path, fileRef: contentFileRef(bytes, source.path) })
  })
  return refs
}

async function readHandedSources(
  input: {
    readonly files: AgentRunFiles
    readonly sources: readonly HandedSource[]
    readonly signal: AbortSignal
  },
  use: (source: HandedSource, bytes: Uint8Array) => Promise<void>
): Promise<void> {
  const handle = await input.files.sandbox()
  let totalBytes = 0
  for (const source of input.sources) {
    if (source.sizeBytes !== undefined && source.sizeBytes > fileMaxBytes) {
      throw fileTooLarge(source.path)
    }

    const bytes = await readSandboxFile(handle, {
      path: source.absolutePath,
      maxBytes: fileMaxBytes,
      signal: input.signal,
      timeoutMs: SANDBOX_TIMEOUT_MS,
    }).catch((error: unknown) => {
      throw toHandOffError(error, source.path)
    })
    if (bytes.byteLength > fileMaxBytes) throw fileTooLarge(source.path)

    totalBytes += bytes.byteLength
    assertWithinTotal(totalBytes)
    await use(source, bytes)
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
  /**
   * The files are in the sandbox already, as a resumed workspace kept them: listed, not copied,
   * so what the child changed in them stays. Those in the context directory are copied again:
   * every run starts without it.
   */
  readonly inSandbox?: boolean
  /** The child's context directory, relative to its working directory or absolute. */
  readonly contextDirectory: string
  readonly blobStorage: BlobStorage
  readonly signal?: AbortSignal
}): Promise<PreparedAgentAttachmentContext> {
  const signal = input.signal ?? NEVER_ABORTED_SIGNAL
  const sandboxFiles: PreparedAgentAttachmentContext["sandboxFiles"][number][] = []

  const copied = input.inSandbox
    ? input.files.filter((file) => isRunFile(file.path, input.contextDirectory))
    : input.files
  for (const { path, fileRef } of copied) {
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
 * Store what a child that finished wrote under `out/`, by path relative to it, against a budget of
 * their own: what the child published does not count. A file its parent handed over there and the
 * child left unchanged does not come back. Past the attachment limits, none comes back and `error`
 * says why, so the child's answer still does.
 */
export async function storeChildOutputs(input: {
  readonly files: AgentRunFiles
  readonly handed: readonly SubagentRunFile[]
  readonly signal: AbortSignal
}): Promise<{ readonly files: readonly SubagentRunFile[]; readonly error?: string }> {
  const { signal } = input
  const handle = await input.files.sandbox()
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

  // Checked before reading anything: these files come back whatever their bytes.
  const tooMany = outputLimitError(
    listing.files.filter((file) => !maybeHanded(file)),
    listing.truncated
  )
  if (tooMany) return { files: [], error: tooMany }

  const kept: { readonly entry: SandboxFileEntry; readonly bytes: Uint8Array }[] = []
  for (const entry of listing.files) {
    let bytes: Uint8Array
    try {
      bytes = await readSandboxFile(handle, {
        path: posix.join(directory, entry.relativePath),
        maxBytes: fileMaxBytes,
        signal,
        timeoutMs: SANDBOX_TIMEOUT_MS,
      })
    } catch (error) {
      if (!(error instanceof SandboxFileError)) throw error
      return { files: [], error: outputError(`'out/${entry.relativePath}': ${error.message}`) }
    }
    if (handedAt(entry.relativePath)?.digest === `sha256:${sha256(bytes)}`) continue

    kept.push({ entry: { relativePath: entry.relativePath, sizeBytes: bytes.byteLength }, bytes })
  }
  const pastLimits = outputLimitError(kept.map((file) => file.entry))
  if (pastLimits) return { files: [], error: pastLimits }

  // The child's outputs have a budget of their own, within the limits checked above.
  const reservation = new AgentFileBudget(totalMaxBytes).reserve(0, "out/")
  const files: SubagentRunFile[] = []
  for (const { entry, bytes } of kept) {
    files.push({
      path: entry.relativePath,
      fileRef: await storeFile(input.files, reservation, bytes, entry.relativePath, signal),
    })
  }
  return { files }
}

/**
 * The parent's side: copy what a child wrote under `out/` into the parent's sandbox for the turn,
 * under `children/<key>/` in its context directory. Each file's reference names it by that path,
 * as its `logicalPath`, and by a name no other file of the child shares, so a later turn tells
 * them apart in `$SIXB_ATTACHMENTS`.
 */
export async function installChildOutputs(input: {
  readonly files: AgentRunFiles
  readonly key: string
  readonly outputs: readonly SubagentRunFile[]
  readonly signal: AbortSignal
}): Promise<readonly InstalledChildFile[]> {
  const { signal } = input
  const handle = await input.files.sandbox()
  const childDirectory = childDirectoryName(input.key)
  const directory = posix.join(handle.contextDirectory, CHILD_FILES_DIRECTORY, childDirectory)

  const installed: InstalledChildFile[] = []
  const names = new Set<string>()
  for (const { path, fileRef } of input.outputs) {
    // One file at a time: a child's files can hold 100 MB.
    const contents = await readBlob(input.files.blobStorage, fileRef.blobId, signal)
    signal.throwIfAborted()
    await handle.sandbox.writeFiles([
      { path: posix.resolve(handle.sandbox.workingDirectory, directory, path), contents },
    ])

    const name = `${childDirectory}-${path.split("/").join("-")}`
    let fileName = name
    for (let copy = 2; names.has(fileName); copy += 1) fileName = `${copy}-${name}`
    names.add(fileName)
    installed.push({
      path,
      fileRef: { ...fileRef, fileName, logicalPath: posix.join(childDirectory, path) },
      sandboxPath: posix.join(directory, path),
    })
  }
  return installed
}

/** A spawn key as one path segment; one that needs changing gets a hash, so two never collide. */
function childDirectoryName(key: string): string {
  if (/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(key)) return key

  const safe = key.replace(/[^A-Za-z0-9._-]/g, "_").replace(/^[._-]+/, "")
  return `${safe.slice(0, 96) || "child"}-${sha256(new TextEncoder().encode(key)).slice(0, 8)}`
}

async function handedSourcesAt(
  handle: AgentSandboxHandle,
  realRoot: string,
  path: string,
  signal: AbortSignal
): Promise<readonly HandedSource[]> {
  const root = posix.resolve(handle.sandbox.workingDirectory)
  let requested: string
  try {
    requested = resolveSandboxPath(root, path)
  } catch (error) {
    throw toHandOffError(error, path)
  }
  const childPath = posix.relative(root, requested)

  // What the path really is decides what it may hand over: a link must not reach the run context.
  const entry = await resolveSandboxEntry(handle, {
    path: requested,
    signal,
    timeoutMs: SANDBOX_TIMEOUT_MS,
  }).catch((error: unknown) => {
    throw toHandOffError(error, path)
  })
  if (entry.kind === "missing") throw handOffError(`'${path}': it does not exist`)
  if (entry.kind === "link") throw handOffError(`'${path}': it is a symbolic link`)
  const realPath = posix.relative(realRoot, entry.realPath)
  if (realPath === "" || realPath.startsWith("../") || realPath === "..") {
    throw handOffError(`'${path}': it leads outside the sandbox working directory`)
  }
  assertHandable(handle, realPath, path)

  if (entry.kind === "file") {
    return [{ path: childPath, absolutePath: entry.realPath }]
  }

  let listing: SandboxFileListing
  try {
    listing = await listSandboxFiles(handle, {
      directory: entry.realPath,
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
  if (listing.files.length === 0) throw handOffError(`'${path}': it is an empty directory`)

  // A listing reaches no file through a link, so each file is where it is listed.
  return listing.files.map((file) => ({
    path: posix.join(childPath, file.relativePath),
    absolutePath: posix.join(entry.realPath, file.relativePath),
    sizeBytes: file.sizeBytes,
  }))
}

/**
 * Hands over nothing of the run's context directory but its files: the context holds the run's
 * API address. Checked where a path really is; a copy the Agent makes with `cp` is not.
 */
function assertHandable(handle: AgentSandboxHandle, relativePath: string, requested: string): void {
  const contextDirectory = posix.relative(
    posix.resolve(handle.sandbox.workingDirectory),
    contextPath(handle)
  )
  const runFile = isRunFile(relativePath, contextDirectory)
  const handed = HANDED_RUN_DIRECTORIES.some((directory) =>
    `${relativePath}/`.startsWith(`${contextDirectory}/${directory}/`)
  )
  if (!runFile || handed) {
    return
  }

  throw handOffError(
    `'${requested}': it is part of the run context Sixb installs under ${handle.contextDirectory}. Hand over files from your working directory, $SIXB_ATTACHMENT_DIR, $SIXB_ARTIFACTS_DIR or ${posix.join(handle.contextDirectory, CHILD_FILES_DIRECTORY)}`
  )
}

async function storeFile(
  files: AgentRunFiles,
  reservation: ReturnType<AgentFileBudget["reserve"]>,
  bytes: Uint8Array,
  path: string,
  signal: AbortSignal
): Promise<FileRef> {
  // Blob storage keeps identical bytes once: a file handed to several children counts once.
  const expected = contentFileRef(bytes, path)
  reservation.addContent(sha256(bytes), bytes.byteLength)
  const stored = await files.blobStorage.put({
    body: bytes,
    expectedSizeBytes: bytes.byteLength,
    signal,
    ...(expected.fileName === undefined ? {} : { fileName: expected.fileName }),
    ...(expected.mediaType === undefined ? {} : { mediaType: expected.mediaType }),
  })
  if (stored.blobId !== expected.blobId) {
    throw new Error(`[SixbAgentWorker] Blob storage stored '${path}' under another id.`)
  }
  return stored
}

/** The reference blob storage gives these bytes, named after `path`: its id is their SHA-256. */
function contentFileRef(bytes: Uint8Array, path: string): FileRef {
  const hex = sha256(bytes)
  const fileName = posix.basename(path)
  return {
    blobId: `blob_${hex}`,
    digest: `sha256:${hex}`,
    sizeBytes: bytes.byteLength,
    fileName,
    mediaType: inferFileMediaType(fileName, bytes),
  }
}

function assertWithinTotal(totalBytes: number): void {
  if (totalBytes <= totalMaxBytes) return

  const limit = formatBytes(totalMaxBytes)
  throw handOffError(`more than ${limit}; a child receives at most ${limit} in all`)
}

function fileTooLarge(path: string): AgentToolPublicError {
  return handOffError(
    `'${path}': it holds more than ${formatBytes(fileMaxBytes)}, the most a file handed to a child may hold`
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

/** Why the files a child left in `out/` do not come back, or nothing when they do. */
function outputLimitError(
  files: readonly SandboxFileEntry[],
  truncated = false
): string | undefined {
  if (truncated || files.length > maxFiles) {
    return outputError(`It left more than ${maxFiles} files in out/`)
  }
  const tooLarge = files.find((file) => file.sizeBytes > fileMaxBytes)
  if (tooLarge) {
    return outputError(
      `'out/${tooLarge.relativePath}' holds more than ${formatBytes(fileMaxBytes)}`
    )
  }
  if (files.reduce((sum, file) => sum + file.sizeBytes, 0) > totalMaxBytes) {
    return outputError(`Its files in out/ hold more than ${formatBytes(totalMaxBytes)} in all`)
  }
  return undefined
}

function outputError(problem: string): string {
  return `${problem}, so none of its files came back: at most ${maxFiles} files of ${formatBytes(fileMaxBytes)}, ${formatBytes(totalMaxBytes)} in all, do. To get them, spawn it again with a task that writes fewer or smaller files to out/, or that publishes them.`
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex")
}
