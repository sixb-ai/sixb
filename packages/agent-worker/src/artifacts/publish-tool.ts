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
import { SLIDES_ENTRY } from "@sixb/core/internal/artifacts/frames"
import {
  ARTIFACT_LIMITS,
  isArtifactId,
  publishArtifact,
} from "@sixb/core/internal/artifacts/publish"
import { inferFileMediaType } from "@sixb/core/internal/blob-storage"
import type { JsonObject, ModelTool } from "@sixb/core/models"
import type { ArtifactFile, ArtifactRecord, ArtifactStorage } from "@sixb/core/storage"
import { AgentExecutionLostError } from "../errors"
import { agentToolErrorText } from "../model-adapters"
import {
  listSandboxFiles,
  readSandboxFile,
  resolveSandboxPath,
  SandboxFileError,
} from "../sandbox-files"
import type { AgentSandboxHandle } from "../sandbox-handle"
import type { AgentFileBudget } from "../tools/tool-files"
import { checkDeckLayout, type LayoutCheck } from "./layout-check/layout-check"

const CREATE_TOOL = "publish_artifact"
const VERSION_TOOL = "publish_artifact_version"
type PublishToolName = typeof CREATE_TOOL | typeof VERSION_TOOL
const SANDBOX_TIMEOUT_MS = 30_000
/** The kinds the Agent can create today; each lands with its validator, renderer, and skill. */
const PUBLISHABLE_KINDS = ["document", "sheet", "slides", "file"] as const
type PublishableKind = (typeof PUBLISHABLE_KINDS)[number]

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
  readonly storage: Storage
  readonly blobStorage: BlobStorage
  readonly run: PublishingRun
  /** The thread's owner, who owns what the Agent publishes. */
  readonly owner: Principal
  /** Shared with every other file the run stores. */
  readonly budget: AgentFileBudget
  readonly resolveSandbox: () => Promise<AgentSandboxHandle>
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
      errorText: agentToolErrorText,
    },
    {
      ...PUBLISH_ARTIFACT_VERSION_TOOL_SPEC,
      parseInput: parsePublishArtifactVersionInput,
      execute: (request, { signal }) =>
        publish(input, VERSION_TOOL, { ...request, target: { artifactId: request.id } }, signal),
      toModelOutput: (output) => ({ type: "text", value: publishSummary(output, VERSION_TOOL) }),
      errorText: agentToolErrorText,
    },
  ]
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
  await assertRunIsCurrent(input.storage, input.projectId, input.run)
  const kind: ArtifactKind =
    "kind" in request.target
      ? request.target.kind
      : (await ownedArtifact(input, input.storage.artifacts, request.target.artifactId, tool)).kind
  const handle = await input.resolveSandbox()
  const sources = await listSources(handle, request.path, kind, tool, signal)

  const totalBytes = sources.reduce((sum, source) => sum + source.sizeBytes, 0)
  if (totalBytes > ARTIFACT_LIMITS.maxVersionBytes) {
    throw publishError(
      tool,
      `the files hold ${totalBytes} bytes; a version may hold at most ${ARTIFACT_LIMITS.maxVersionBytes}`
    )
  }
  const reservation = input.budget.reserve(totalBytes, tool)
  let entry: { readonly directory: string; readonly bytes: Uint8Array } | undefined
  let published: Awaited<ReturnType<typeof publishArtifact>>
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
      if (kind === "slides" && source.path === SLIDES_ENTRY) {
        entry = { directory: posix.dirname(source.absolutePath), bytes }
      }
      const fileName = posix.basename(source.path)
      const fileRef = await input.blobStorage.put({
        body: bytes,
        expectedSizeBytes: bytes.byteLength,
        signal,
        fileName,
        mediaType: inferFileMediaType(fileName, bytes),
      })
      files.push({ path: source.path, file: fileRef })
    }
    signal.throwIfAborted()

    published = await input.storage.transaction(async (tx) => {
      await assertRunIsCurrent(tx, input.projectId, input.run)
      const artifacts = tx.artifacts
      if (!artifacts) throw publishError(tool, "artifacts need storage that supports them")
      // The owner may have deleted it since the check above.
      if ("artifactId" in request.target) {
        await ownedArtifact(input, artifacts, request.target.artifactId, tool)
      }
      return publishArtifact(
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
    })
  } catch (error) {
    // Nothing was published, so the bytes do not count against the run.
    reservation.release()
    throw toPublishError(error, tool)
  }

  // A published deck is laid out in the sandbox's browser, so the Agent sees what the reader
  // will, and fixes it in its next version.
  const check: LayoutCheck | undefined = entry
    ? await checkDeckLayout({
        handle,
        directory: entry.directory,
        entry: entry.bytes,
        name: `${published.artifact.id}-v${published.version.version}`,
        signal,
      })
    : undefined
  return {
    artifactId: published.artifact.id,
    version: published.version.version,
    kind: published.artifact.kind,
    title: published.version.title,
    warnings: [...published.warnings, ...(check?.status === "checked" ? check.warnings : [])].map(
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
  artifacts: ArtifactStorage | undefined,
  artifactId: string,
  tool: PublishToolName
): Promise<ArtifactRecord> {
  if (!artifacts) throw publishError(tool, "artifacts need storage that supports them")
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

/** A run reclaimed by another delivery, or already finished, must not publish. */
async function assertRunIsCurrent(
  storage: Storage,
  projectId: string,
  run: PublishingRun
): Promise<void> {
  const stored = await storage.agents?.runs.getById({ projectId, id: run.id })
  if (
    !stored ||
    stored.status !== "running" ||
    stored.execution?.token !== run.executionToken ||
    stored.execution.queueLeaseExpiresAt.getTime() <= Date.now()
  ) {
    throw new AgentExecutionLostError(run.id)
  }
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
    if (typeof check.skipped === "string") {
      lines.push(`The layout check did not run: ${check.skipped}. Read index.html slide by slide.`)
    } else if (screenshots.length > 0) {
      const directory = posix.dirname(screenshots[0] ?? "")
      lines.push(
        `Layout check: each slide as the reader sees it in light mode is ${directory}/slide-NN.png (${screenshots.length} slides). Open them with view_file, fix what the warnings name, and publish the next version.`
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
