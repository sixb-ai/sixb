import { createHash } from "node:crypto"
import { posix } from "node:path"
import {
  AgentToolPublicError,
  type ArtifactKind,
  ArtifactRequestError,
  type BlobStorage,
  type JsonValue,
  type Principal,
  principalsEqual,
  type Storage,
} from "@sixb/core"
import { ARTIFACT_KINDS, ARTIFACT_THEME_FILE, parseArtifactTheme } from "@sixb/core/artifacts"
import { frameLayout } from "@sixb/core/internal/artifacts/frames"
import {
  ARTIFACT_LIMITS,
  artifactVersionWarnings,
  isArtifactId,
  prepareArtifactVersion,
  storeArtifactVersion,
} from "@sixb/core/internal/artifacts/publish"
import { inferFileMediaType } from "@sixb/core/internal/blob-storage"
import type { JsonObject, ModelTool } from "@sixb/core/models"
import type { ArtifactFile, ArtifactRecord, ArtifactStorage } from "@sixb/core/storage"
import { AgentExecutionLostError, assertRunExecutionOwned } from "../errors"
import { agentToolErrorText } from "../model-adapters"
import {
  listSandboxFiles,
  readSandboxFile,
  resolveSandboxPath,
  SandboxFileError,
} from "../sandbox-files"
import type { AgentSandboxHandle } from "../sandbox-handle"
import type { AgentFileBudget } from "../tools/tool-files"
import { checkLayout, type LayoutCheck } from "./layout-check/layout-check"
import type { InstalledArtifacts, PublishedArtifactFile } from "./materialize"

const CREATE_TOOL = "publish_artifact"
const VERSION_TOOL = "publish_artifact_version"
type PublishToolName = typeof CREATE_TOOL | typeof VERSION_TOOL
const SANDBOX_TIMEOUT_MS = 30_000
/** The kinds the Agent can create today; each lands with its validator, renderer, and skill. */
const PUBLISHABLE_KINDS = ARTIFACT_KINDS
type PublishableKind = ArtifactKind

// Creating and revising are two tools, and every argument of each is required and meaningful. A
// mode carried by an optional or null argument is where models differ: some fill every field, some
// send "null" or "" for nothing. Every model picks a tool by name. With all properties required
// and no length or pattern keywords, every model adapter can also send both schemas as strict.
const PATH_PROPERTY = {
  type: "string",
  description: "A file or a directory in the sandbox, relative to the working directory.",
} as const
const TITLE_PROPERTY = {
  type: "string",
  description: `Plain text of at most ${ARTIFACT_LIMITS.maxTitleLength} characters naming the deliverable.`,
} as const

export const PUBLISH_ARTIFACT_TOOL_SPEC = {
  name: CREATE_TOOL,
  description:
    "Publish a new artifact from a file or directory in the sandbox: a deliverable the user opens beside the conversation. Read the sixb-artifacts skill before the first publish. To change an artifact you already published, use publish_artifact_version. Returns the artifact's id and version; a refusal says what to fix.",
  inputSchema: {
    type: "object",
    properties: {
      path: PATH_PROPERTY,
      kind: { type: "string", enum: [...PUBLISHABLE_KINDS] },
      title: TITLE_PROPERTY,
    },
    required: ["path", "kind", "title"],
    additionalProperties: false,
  } satisfies JsonObject,
} as const

export const PUBLISH_ARTIFACT_VERSION_TOOL_SPEC = {
  name: VERSION_TOOL,
  description:
    "Publish the next version of an artifact you published, from a file or directory in the sandbox. It keeps its kind, and its earlier versions stay readable. $SIXB_ARTIFACTS lists this conversation's artifacts, each with its latest version under $SIXB_ARTIFACTS_DIR/<id>/. Returns the new version; a refusal says what to fix.",
  inputSchema: {
    type: "object",
    properties: {
      id: { type: "string", description: "The artifact's id, such as art_k3m9q2x7tp." },
      path: PATH_PROPERTY,
      title: TITLE_PROPERTY,
    },
    required: ["id", "path", "title"],
    additionalProperties: false,
  } satisfies JsonObject,
} as const

export interface PublishArtifactToolInput {
  readonly path: string
  readonly kind: PublishableKind
  readonly title: string
}

export interface PublishArtifactVersionToolInput {
  readonly id: string
  readonly path: string
  readonly title: string
}

/** The run that publishes, and the token that proves it still owns its conversation. */
export interface PublishingRun {
  readonly id: string
  readonly threadId: string
  readonly executionToken: string
}

interface PublishToolsInput {
  readonly projectId: string
  /** For the transaction that publishes. */
  readonly storage: Storage
  readonly artifacts: ArtifactStorage
  readonly blobStorage: BlobStorage
  readonly run: PublishingRun
  /** The thread's owner, who owns what the Agent publishes. */
  readonly owner: Principal
  /** Shared with every other file the run stores. */
  readonly budget: AgentFileBudget
  readonly resolveSandbox: () => Promise<AgentSandboxHandle>
  /** The conversation's artifacts in the sandbox, which each publish keeps current. */
  readonly installed: Promise<InstalledArtifacts>
}

/**
 * `publish_artifact` and `publish_artifact_version`: each reads a file or a directory from the
 * sandbox, stores its bytes, and publishes them as the thread's owner with the thread and run as
 * origin. The version exists when the tool returns, so the conversation shows it mid-turn and a
 * cancelled run keeps it. Publishing commits only while the run still owns its execution: a run
 * reclaimed by another delivery publishes nothing.
 */
export function createPublishArtifactTools(
  input: PublishToolsInput
): readonly [ModelTool<PublishArtifactToolInput>, ModelTool<PublishArtifactVersionToolInput>] {
  return [
    {
      ...PUBLISH_ARTIFACT_TOOL_SPEC,
      parseInput: parsePublishArtifactInput,
      execute: (request, { signal }) =>
        publish(input, CREATE_TOOL, { ...request, target: { kind: request.kind } }, signal),
      toModelOutput: (output) => ({ type: "text", value: publishSummary(output, CREATE_TOOL) }),
      errorText: (error) => publishErrorText(error, CREATE_TOOL),
    },
    {
      ...PUBLISH_ARTIFACT_VERSION_TOOL_SPEC,
      parseInput: parsePublishArtifactVersionInput,
      execute: (request, { signal }) =>
        publish(input, VERSION_TOOL, { ...request, target: { artifactId: request.id } }, signal),
      toModelOutput: (output) => ({ type: "text", value: publishSummary(output, VERSION_TOOL) }),
      errorText: (error) => publishErrorText(error, VERSION_TOOL),
    },
  ]
}

/** A run that lost its conversation stores nothing, and the trace says so instead of "an error". */
function publishErrorText(error: unknown, tool: PublishToolName): string {
  return error instanceof AgentExecutionLostError
    ? publishError(tool, "this run no longer holds its conversation, so nothing was published")
        .message
    : agentToolErrorText(error)
}

interface PublishRequest {
  readonly path: string
  readonly title: string
  /** A new artifact of this kind, or the next version of this artifact. */
  readonly target: { readonly kind: PublishableKind } | { readonly artifactId: string }
}

async function publish(
  input: PublishToolsInput,
  tool: PublishToolName,
  request: PublishRequest,
  signal: AbortSignal
): Promise<JsonValue> {
  signal.throwIfAborted()
  const { artifacts } = input
  const ownership = { projectId: input.projectId, ...input.run }
  await assertRunExecutionOwned(input.storage, ownership)
  const kind: ArtifactKind =
    "kind" in request.target
      ? request.target.kind
      : (await ownedArtifact(input, artifacts, request.target.artifactId, tool)).kind
  const handle = await input.resolveSandbox()
  const sources = await listSources(handle, request.path, kind, tool, signal)

  const totalBytes = sources.reduce((sum, source) => sum + source.sizeBytes, 0)
  if (totalBytes > ARTIFACT_LIMITS.maxVersionBytes) {
    throw publishError(
      tool,
      `the files hold ${totalBytes} bytes; a version may hold at most ${ARTIFACT_LIMITS.maxVersionBytes}`
    )
  }
  const reservation = input.budget.reserve(0, tool)
  const contents: PublishedArtifactFile[] = []
  let published: Awaited<ReturnType<typeof storeArtifactVersion>>
  let prepared: Awaited<ReturnType<typeof prepareArtifactVersion>>
  try {
    const files: ArtifactFile[] = []
    for (const source of sources) {
      const bytes =
        source.bytes ??
        (await readSandboxFile(handle, {
          path: source.absolutePath,
          maxBytes: ARTIFACT_LIMITS.maxFileBytes,
          signal,
          timeoutMs: SANDBOX_TIMEOUT_MS,
        }).catch((error: unknown) => {
          throw toPublishError(error, tool, source.path)
        }))
      if (bytes.byteLength !== source.sizeBytes) {
        throw publishError(tool, `'${source.path}' changed while it was being read; publish again`)
      }
      // Blob storage keeps identical bytes once, so a file the run already stored, such as one a
      // next version keeps, costs the budget nothing again.
      reservation.addContent(createHash("sha256").update(bytes).digest("hex"), bytes.byteLength)
      const fileName = posix.basename(source.path)
      const fileRef = await input.blobStorage.put({
        body: bytes,
        expectedSizeBytes: bytes.byteLength,
        signal,
        fileName,
        mediaType: inferFileMediaType(fileName, bytes),
      })
      files.push({ path: source.path, file: fileRef })
      contents.push({ path: source.path, bytes })
    }
    signal.throwIfAborted()

    // Validation reads the files back and parses them, so it runs before the transaction, which
    // only checks the run still owns its conversation and stores.
    prepared = await prepareArtifactVersion(
      { projectId: input.projectId, storage: artifacts, blobStorage: input.blobStorage },
      {
        ...("artifactId" in request.target ? { artifactId: request.target.artifactId } : {}),
        kind,
        title: request.title,
        files,
        author: input.owner,
        origin: { threadId: input.run.threadId, runId: input.run.id },
      }
    )
    published = await input.storage.transaction(async (tx) => {
      await assertRunExecutionOwned(tx, ownership)
      const stored = tx.artifacts
      if (!stored) throw new Error("[SixbAgentWorker] Storage transactions hold no artifacts.")
      // The owner may have deleted it since the check above.
      if ("artifactId" in request.target) {
        await ownedArtifact(input, stored, request.target.artifactId, tool)
      }
      return storeArtifactVersion(
        { projectId: input.projectId, storage: stored, blobStorage: input.blobStorage },
        prepared
      )
    })
  } catch (error) {
    // Nothing was published, so the bytes do not count against the run.
    reservation.release()
    throw toPublishError(error, tool)
  }

  // The version exists by now: nothing below may read as a failed publish, which the Agent would
  // publish again.
  const warnings = await artifactVersionWarnings(
    { projectId: input.projectId, storage: artifacts, blobStorage: input.blobStorage },
    prepared,
    published
  )
  try {
    // Revising from $SIXB_ARTIFACTS_DIR must start from this version, not the one before.
    await (await input.installed).replace(handle.sandbox, published, contents, signal)
  } catch (error) {
    if (signal.aborted) throw error
    console.warn(
      `[SixbAgentWorker] Could not install version ${published.version.version} of artifact '${published.artifact.id}':`,
      error
    )
  }
  // A published deck, page, or canvas is laid out in the sandbox's browser, so the Agent sees what
  // the reader will, and fixes it in its next version.
  const layout = frameLayout(kind)
  const { outline, entry } = published.version
  const root = layout ? sources.find((source) => source.path === entry) : undefined
  const bytesOf = (path: string) => contents.find((file) => file.path === path)?.bytes
  const themeFile = contents.find((file) => file.path === ARTIFACT_THEME_FILE)
  // Publishing has read it already: a version with a theme.json it refused is not here.
  const theme = themeFile ? parseArtifactTheme(new TextDecoder().decode(themeFile.bytes)) : null
  // What the check opens: a canvas's boards, each at its own size, or the entry.
  const pages =
    outline.kind === "canvas"
      ? {
          layout: "canvas" as const,
          boards: outline.items.flatMap((item) => {
            const html = item.type === "board" ? bytesOf(item.file) : undefined
            return item.type === "board" && html
              ? [{ id: item.id, file: item.file, w: item.w, h: item.h, html }]
              : []
          }),
        }
      : layout && bytesOf(entry)
        ? { layout, entry: bytesOf(entry) as Uint8Array }
        : null
  let check: LayoutCheck | undefined
  if (root && pages && (pages.layout !== "canvas" || pages.boards.length > 0)) {
    try {
      check = await checkLayout({
        handle,
        ...pages,
        directory: posix.dirname(root.absolutePath),
        files: contents.map((file) => file.path),
        name: `${published.artifact.id}-v${published.version.version}`,
        ...(theme && "theme" in theme ? { theme: theme.theme } : {}),
        signal,
      })
    } catch (error) {
      if (signal.aborted) throw error
      console.warn("[SixbAgentWorker] The layout check failed:", error)
      check = { status: "skipped", reason: "the check failed in the sandbox" }
    }
  }
  return {
    artifactId: published.artifact.id,
    version: published.version.version,
    kind: published.artifact.kind,
    title: published.version.title,
    warnings: [...warnings, ...(check?.status === "checked" ? check.warnings : [])].map(
      ({ code, message, part }) => ({ code, message, ...(part === undefined ? {} : { part }) })
    ),
    ...(check === undefined
      ? {}
      : {
          layoutCheck:
            check.status === "checked"
              ? { screenshots: [...check.screenshots] }
              : { skipped: check.reason },
        }),
  }
}

/** The artifact to publish a version of: one the thread's owner has. */
async function ownedArtifact(
  input: PublishToolsInput,
  artifacts: ArtifactStorage,
  artifactId: string,
  tool: PublishToolName
): Promise<ArtifactRecord> {
  const artifact = await artifacts.get({ projectId: input.projectId, id: artifactId })
  if (!artifact || !principalsEqual(artifact.owner, input.owner)) {
    throw publishError(
      tool,
      `there is no artifact '${artifactId}'. $SIXB_ARTIFACTS lists this conversation's artifacts; to create a new one, call ${CREATE_TOOL}`
    )
  }
  return artifact
}

interface PublishSource {
  /** The file's path in the artifact. */
  readonly path: string
  readonly absolutePath: string
  readonly sizeBytes: number
  /** Already read: a single file is read once, while the path is checked. */
  readonly bytes?: Uint8Array
}

/**
 * A directory publishes every file under it at its relative path, skipping names that start with
 * a dot. A single file publishes alone: a document's Markdown as `document.md`, any other file
 * under its own name.
 */
async function listSources(
  handle: AgentSandboxHandle,
  path: string,
  kind: ArtifactKind,
  tool: PublishToolName,
  signal: AbortSignal
): Promise<PublishSource[]> {
  let absolutePath: string
  try {
    absolutePath = resolveSandboxPath(handle.sandbox.workingDirectory, path)
  } catch (error) {
    throw toPublishError(error, tool)
  }
  const listing = await listSandboxFiles(handle, {
    directory: absolutePath,
    maxFiles: ARTIFACT_LIMITS.maxFiles * 2,
    signal,
    timeoutMs: SANDBOX_TIMEOUT_MS,
  }).catch((error: unknown) => {
    throw toPublishError(error, tool)
  })

  if (listing.files.length === 0 && !listing.truncated) {
    if (listing.directory) throw publishError(tool, `'${path}' is an empty directory`)
    // A missing path lists nothing as well; reading it says which.
    const bytes = await readSandboxFile(handle, {
      path: absolutePath,
      maxBytes: ARTIFACT_LIMITS.maxFileBytes,
      signal,
      timeoutMs: SANDBOX_TIMEOUT_MS,
    }).catch((error: unknown) => {
      throw toPublishError(error, tool, path)
    })
    return [
      {
        path: kind === "document" ? "document.md" : posix.basename(absolutePath),
        absolutePath,
        sizeBytes: bytes.byteLength,
        bytes,
      },
    ]
  }

  const files = listing.files.filter(
    (file) => !file.relativePath.split("/").some((segment) => segment.startsWith("."))
  )
  if (listing.truncated || files.length > ARTIFACT_LIMITS.maxFiles) {
    throw publishError(
      tool,
      `'${path}' holds more than ${ARTIFACT_LIMITS.maxFiles} files; a version may hold at most ${ARTIFACT_LIMITS.maxFiles}`
    )
  }
  if (files.length === 0) throw publishError(tool, `'${path}' holds no files to publish`)
  for (const file of files) {
    if (file.sizeBytes > ARTIFACT_LIMITS.maxFileBytes) {
      throw publishError(
        tool,
        `'${file.relativePath}' is ${file.sizeBytes} bytes; a file may be at most ${ARTIFACT_LIMITS.maxFileBytes}`
      )
    }
  }
  return files.map((file) => ({
    path: file.relativePath,
    absolutePath: posix.join(absolutePath, file.relativePath),
    sizeBytes: file.sizeBytes,
  }))
}

function publishSummary(output: JsonValue, tool: PublishToolName): string {
  if (typeof output !== "object" || output === null || Array.isArray(output)) {
    return JSON.stringify(output)
  }
  const lines = [
    `Published "${String(output.title)}" as artifact ${String(output.artifactId)}, version ${String(output.version)}.`,
  ]
  if (tool === CREATE_TOOL) {
    lines.push(`To change it, publish its next version with ${VERSION_TOOL} and this id.`)
  }
  const warnings = Array.isArray(output.warnings) ? output.warnings : []
  for (const warning of warnings) {
    if (typeof warning === "object" && warning !== null && !Array.isArray(warning)) {
      lines.push(
        `Warning${warning.part ? ` (${String(warning.part)})` : ""}: ${String(warning.message)}`
      )
    }
  }
  const check = output.layoutCheck
  if (typeof check === "object" && check !== null && !Array.isArray(check)) {
    const screenshots = Array.isArray(check.screenshots) ? check.screenshots.map(String) : []
    const kind = output.kind
    if (typeof check.skipped === "string") {
      lines.push(
        `The layout check did not run: ${check.skipped}. ${
          kind === "page"
            ? "Read index.html and its scripts closely."
            : kind === "canvas"
              ? "Read each board's HTML closely."
              : "Read index.html slide by slide."
        }`
      )
    } else if (screenshots.length > 0) {
      const directory = posix.dirname(screenshots[0] ?? "")
      lines.push(
        kind === "page"
          ? `Layout check: the page as the reader sees it, in light mode or the mode its theme.json pins, is ${directory}/desktop.png at 1280px and ${directory}/phone.png at 390px, each its top 4000px. Open them with view_file, fix what the warnings name, and publish the next version.`
          : kind === "canvas"
            ? `Layout check: each board as the reader sees it, at its own size, in light mode or the mode its theme.json pins, is ${directory}/<id>.png (${screenshots.length} boards). Open them with view_file, fix what the warnings name, and publish the next version.`
            : `Layout check: each slide as the reader sees it, in light mode or the mode its theme.json pins, is ${directory}/slide-NN.png (${screenshots.length} slides). Open them with view_file, fix what the warnings name, and publish the next version.`
      )
    }
  }
  return lines.join("\n")
}

function parsePublishArtifactInput(value: unknown): PublishArtifactToolInput {
  const input = inputObject(value, CREATE_TOOL, ["path", "kind", "title"])
  if (!PUBLISHABLE_KINDS.includes(input.kind as PublishableKind)) {
    throw publishError(CREATE_TOOL, `kind must be one of ${PUBLISHABLE_KINDS.join(", ")}`)
  }
  return {
    path: pathInput(input.path, CREATE_TOOL),
    kind: input.kind as PublishableKind,
    title: titleInput(input.title, CREATE_TOOL),
  }
}

function parsePublishArtifactVersionInput(value: unknown): PublishArtifactVersionToolInput {
  const input = inputObject(value, VERSION_TOOL, ["id", "path", "title"])
  const id = typeof input.id === "string" ? input.id.trim() : ""
  if (!isArtifactId(id)) {
    throw publishError(
      VERSION_TOOL,
      `id must be an artifact id such as art_k3m9q2x7tp. $SIXB_ARTIFACTS lists this conversation's artifacts; to create a new one, call ${CREATE_TOOL}`
    )
  }
  return {
    id,
    path: pathInput(input.path, VERSION_TOOL),
    title: titleInput(input.title, VERSION_TOOL),
  }
}

function inputObject(
  value: unknown,
  tool: PublishToolName,
  keys: readonly string[]
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw publishError(tool, "input must be an object")
  }
  const input = value as Record<string, unknown>
  const unknownKey = Object.keys(input).find((key) => !keys.includes(key))
  if (unknownKey) throw publishError(tool, `input has an unknown property '${unknownKey}'`)
  return input
}

function pathInput(value: unknown, tool: PublishToolName): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw publishError(tool, "path must be a file or directory in the sandbox")
  }
  return value
}

function titleInput(value: unknown, tool: PublishToolName): string {
  if (typeof value !== "string") throw publishError(tool, "title must be text")
  return value
}

/** Refusals the Agent can act on become its error text; anything else stays internal. */
function toPublishError(error: unknown, tool: PublishToolName, path?: string): unknown {
  if (error instanceof SandboxFileError) {
    if (error.reason === "not_found" && path !== undefined) {
      return publishError(tool, `there is no file or directory at '${path}'`)
    }
    return publishError(tool, path === undefined ? error.message : `'${path}': ${error.message}`)
  }
  if (error instanceof ArtifactRequestError) {
    return publishError(tool, error.message.replace(/^\[Sixb\] /, ""))
  }
  return error
}

function publishError(tool: PublishToolName, message: string): AgentToolPublicError {
  const sentence = /[.!?]$/.test(message) ? message : `${message}.`
  return new AgentToolPublicError(`[SixbAgentWorker] ${tool} refused: ${sentence}`)
}
