import { createHash } from "node:crypto"
import { posix } from "node:path"
import {
  AgentToolPublicError,
  type ArtifactKind,
  ArtifactRequestError,
  type JsonValue,
  type Principal,
  principalsEqual,
} from "@sixb/core"
import {
  ARTIFACT_KINDS,
  ARTIFACT_THEME_FILE,
  CANVAS_FILE,
  type Canvas,
  parseArtifactTheme,
  parseCanvas,
} from "@sixb/core/artifacts"
import {
  AgentExecutionLostError,
  type AgentRunArtifacts,
  type AgentRunFileStore,
  type AgentRunMissingPreview,
} from "@sixb/core/internal/agents"
import { frameLayout } from "@sixb/core/internal/artifacts/frames"
import {
  ARTIFACT_LIMITS,
  answerArtifactQueries,
  isArtifactId,
  type PublishedArtifact,
  type RefusedBoardPreview,
} from "@sixb/core/internal/artifacts/publish"
import { inferFileMediaType } from "@sixb/core/internal/blob-storage"
import type { JsonObject, ModelTool } from "@sixb/core/models"
import type { ArtifactFile, ArtifactRecord } from "@sixb/core/storage"
import { agentToolErrorText } from "../model-adapters"
import {
  listSandboxFiles,
  readSandboxFile,
  resolveSandboxPath,
  SandboxFileError,
} from "../sandbox-files"
import type { AgentSandboxHandle } from "../sandbox-handle"
import type { AgentFileBudget } from "../tools/tool-files"
import { storeCheckedPreviews } from "./board-previews"
import {
  type CheckedPreview,
  type CheckedQuery,
  checkLayout,
  type LayoutCheck,
  type LayoutWarning,
} from "./layout-check/layout-check"
import {
  type InstalledArtifacts,
  type PublishedArtifactFile,
  readArtifactVersionFiles,
} from "./materialize"

const CREATE_TOOL = "publish_artifact"
const OPEN_TOOL = "open_artifact"
type ArtifactToolName = typeof CREATE_TOOL | typeof OPEN_TOOL
const SANDBOX_TIMEOUT_MS = 30_000
/** The kinds the Agent can create today; each lands with its validator, renderer, and skill. */
const PUBLISHABLE_KINDS = ARTIFACT_KINDS
type PublishableKind = ArtifactKind

// One tool creates and revises: `kind` names a new artifact's, `id` the artifact to revise, whose
// kind stays, so a kind sent with an id is ignored. Every adapter sends the optional fields as it
// can (strict where it may), and an empty id or "null", which a model sends for nothing, is no id:
// ids start `art_`.
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
  strict: true,
  description: [
    "Publish a file or directory in the sandbox as an artifact: a deliverable the user opens beside the conversation. Read the sixb-artifacts skill before the first publish.",
    "Pass kind for a new artifact. Pass id to update one of this conversation's, or one an object the user may edit holds: your files replace its current version's, which stays open, and its kind stays; versions the user created stay as they are. $SIXB_ARTIFACTS lists this conversation's artifacts, each with its current version under $SIXB_ARTIFACTS_DIR/<id>/; open one it does not list with open_artifact first.",
    "Returns the artifact's id, version and revision; a refusal says what to fix.",
  ].join("\n"),
  inputSchema: {
    type: "object",
    properties: {
      path: PATH_PROPERTY,
      title: TITLE_PROPERTY,
      kind: {
        type: "string",
        enum: [...PUBLISHABLE_KINDS],
        description: "A new artifact's kind. With an id it is ignored: an update keeps its kind.",
      },
      id: {
        type: "string",
        description: "The artifact to update, such as art_k3m9q2x7tp. Leave it out to create one.",
      },
    },
    required: ["path", "title"],
    additionalProperties: false,
  } satisfies JsonObject,
} as const

export const OPEN_ARTIFACT_TOOL_SPEC = {
  name: OPEN_TOOL,
  strict: true,
  description:
    "Open an artifact $SIXB_ARTIFACTS does not list, such as one a project object holds: its current version is installed under $SIXB_ARTIFACTS_DIR/<id>/ and listed in $SIXB_ARTIFACTS, to read it, or to revise it with publish_artifact and its id when the user may change it. Publishes nothing. Returns its title, revision, and whether the user may only read it.",
  inputSchema: {
    type: "object",
    properties: {
      id: { type: "string", description: "The artifact's id, such as art_k3m9q2x7tp." },
    },
    required: ["id"],
    additionalProperties: false,
  } satisfies JsonObject,
} as const

/** A publish: of a new artifact by its kind, or of an artifact's current version by its id. */
export type PublishArtifactToolInput = PublishRequest

export interface OpenArtifactToolInput {
  readonly id: string
}

interface PublishToolsInput {
  /** The run's artifacts, through its session: what it reads as its requester, and publishes. */
  readonly artifacts: AgentRunArtifacts
  /** The conversation the run publishes into, and its owner, who owns what the Agent creates. */
  readonly threadId: string
  readonly owner: Principal
  /** Where the version's files are stored before it is published. */
  readonly blobStorage: AgentRunFileStore
  /** Shared with every other file the run stores. */
  readonly budget: AgentFileBudget
  readonly resolveSandbox: () => Promise<AgentSandboxHandle>
  /** The conversation's artifacts in the sandbox, which each publish keeps current. */
  readonly installed: Promise<InstalledArtifacts>
}

/**
 * `publish_artifact` reads a file or a directory from the sandbox, stores its bytes, and publishes
 * them through the run's session, which applies a run's rules (see `AgentRunArtifacts.publish`):
 * a new artifact of its kind, or, by id, the open version's content replaced, or the next version
 * opened after one the user created. What it wrote exists when the tool returns, so the
 * conversation shows it mid-turn and a cancelled run keeps it.
 *
 * `open_artifact` installs one the conversation does not list, as the requester reads it, so an
 * update starts from what it holds.
 */
export function createPublishArtifactTools(
  input: PublishToolsInput
): readonly [ModelTool<PublishArtifactToolInput>, ModelTool<OpenArtifactToolInput>] {
  return [
    {
      ...PUBLISH_ARTIFACT_TOOL_SPEC,
      parseInput: parsePublishArtifactInput,
      execute: (request, { signal }) => publish(input, request, signal),
      toModelOutput: (output) => ({ type: "text", value: publishSummary(output) }),
      errorText: (error) => publishErrorText(error, CREATE_TOOL),
    },
    {
      ...OPEN_ARTIFACT_TOOL_SPEC,
      parseInput: parseOpenArtifactInput,
      execute: (request, { signal }) => open(input, request.id, signal),
      toModelOutput: (output) => ({ type: "text", value: openSummary(output) }),
      errorText: (error) => publishErrorText(error, OPEN_TOOL),
    },
  ]
}

/** A run that lost its conversation stores nothing, and the trace says so instead of "an error". */
function publishErrorText(error: unknown, tool: ArtifactToolName): string {
  return error instanceof AgentExecutionLostError
    ? publishError(tool, "this run no longer holds its conversation, so nothing was published")
        .message
    : agentToolErrorText(error)
}

interface PublishRequest {
  readonly path: string
  readonly title: string
  /** A new artifact of this kind, or this artifact's latest version. */
  readonly target: { readonly kind: PublishableKind } | { readonly artifactId: string }
}

async function publish(
  input: PublishToolsInput,
  request: PublishRequest,
  signal: AbortSignal
): Promise<JsonValue> {
  const tool = CREATE_TOOL
  signal.throwIfAborted()
  const installed = await input.installed

  // One the conversation does not list, such as an artifact an object holds, is opened first: the
  // Agent revises what it holds instead of writing over it unseen.
  if (
    "artifactId" in request.target &&
    installed.revisionOf(request.target.artifactId) === undefined
  ) {
    const { artifactId } = request.target
    if (!(await input.artifacts.get(artifactId))) throw noArtifact(tool, artifactId)

    throw publishError(
      tool,
      `artifact '${artifactId}' is not open in this conversation, so nothing was published: call ${OPEN_TOOL} with its id, then revise its copy and publish it with its id`
    )
  }

  const kind: ArtifactKind =
    "kind" in request.target
      ? request.target.kind
      : (await updatableArtifact(input, request.target.artifactId, tool, installed)).kind

  const handle = await input.resolveSandbox()
  const sources = await listSources(handle, request.path, kind, tool, signal)

  // An installed artifact is updated from its copy: writing past the revision the copy holds would
  // drop whatever was written since. A canvas is merged instead, from the copy's files.
  const base =
    "artifactId" in request.target ? installed.baseOf(request.target.artifactId) : undefined
  const baseRevision =
    "artifactId" in request.target ? installed.revisionOf(request.target.artifactId) : undefined

  const totalBytes = sources.reduce((sum, source) => sum + source.sizeBytes, 0)
  if (totalBytes > ARTIFACT_LIMITS.maxVersionBytes) {
    throw publishError(
      tool,
      `the files hold ${totalBytes} bytes; a version may hold at most ${ARTIFACT_LIMITS.maxVersionBytes}`
    )
  }
  const reservation = input.budget.reserve(0, tool)
  const contents: PublishedArtifactFile[] = []
  let published: PublishedArtifact
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
      // Blob storage keeps identical bytes once, so a file the run already stored, such as one an
      // update keeps, costs the budget nothing again.
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

    published = await input.artifacts.publish({
      ...("artifactId" in request.target
        ? {
            artifactId: request.target.artifactId,
            ...(baseRevision === undefined ? {} : { baseRevision }),
            ...(base ? { baseFiles: base.files } : {}),
          }
        : { kind }),
      title: request.title,
      files,
      // The layout check pictures a canvas's boards as it checks them.
      rendersPreviews: kind === "canvas",
    })
  } catch (error) {
    // Nothing was published, so the bytes do not count against the run.
    reservation.release()

    if (
      error instanceof ArtifactRequestError &&
      error.code === "artifact_moved" &&
      "artifactId" in request.target &&
      baseRevision !== undefined
    ) {
      throw await artifactMoved(
        input,
        { installed, handle },
        { artifactId: request.target.artifactId, baseRevision },
        signal
      )
    }

    if (
      error instanceof ArtifactRequestError &&
      UNREACHABLE.has(error.code) &&
      "artifactId" in request.target
    ) {
      throw noArtifact(tool, request.target.artifactId)
    }

    throw toPublishError(error, tool)
  }

  // The write exists by now: nothing below may read as a failed publish, which the Agent would
  // publish again.
  const { artifact, version } = published
  // Merged with what others wrote since, the version holds more than the Agent's files: the copy
  // and the check take what it holds.
  const written = published.merged ? await mergedFiles(input, published, signal) : contents
  // The folder the Agent published from moves with the installed copy from now on: after a merge
  // it takes the merged result, and its next update, from there, holds its own changes alone.
  const folder = publishedFolder(handle, request.path, sources)
  if (folder) installed.publishedFrom(artifact.id, folder)
  // Revising from $SIXB_ARTIFACTS_DIR must start from this revision, not the one before. When the
  // merged result cannot be read or installed, the copy, the folder and the base all stay as they
  // were: the next update is merged from that base, and keeps what others wrote.
  let copy: string | undefined
  let installedRevision = written !== undefined
  if (written) {
    try {
      await installed.replace(handle.sandbox, published, written, signal)
      copy = installed.directoryOf(artifact.id)
    } catch (error) {
      if (signal.aborted) throw error
      installedRevision = false
      console.warn(
        `[SixbAgent] Could not install revision ${version.revision} of artifact '${artifact.id}':`,
        error
      )
    }
  }
  // A published deck, page, or canvas is laid out in the sandbox's browser, so the Agent sees what
  // the reader will, and fixes it in its next update.
  const layout = frameLayout(kind)
  const { outline, entry } = version
  const root = layout ? sources.find((source) => source.path === entry) : undefined
  // A merged version is checked from its installed copy, which holds what it holds.
  const checked = published.merged ? (written && copy ? written : undefined) : contents
  const checkDirectory = published.merged
    ? copy && posix.resolve(handle.sandbox.workingDirectory, copy)
    : root && posix.dirname(root.absolutePath)
  const bytesOf = (path: string) => checked?.find((file) => file.path === path)?.bytes
  const themeFile = checked?.find((file) => file.path === ARTIFACT_THEME_FILE)
  // Publishing has read it already: a version with a theme.json it refused is not here.
  const theme = themeFile ? parseArtifactTheme(new TextDecoder().decode(themeFile.bytes)) : null
  // A reader sees a canvas's boards as pictures until they open one: the check takes those its
  // boards miss, in every mode. A board kept as it was keeps the pictures it had.
  const missing = outline.kind === "canvas" ? await missingPreviews(input.artifacts, published) : []
  const pictured = new Set(missing.map(({ board }) => board))
  // What the check opens: a canvas's boards, each at its own size, or the entry.
  const pages =
    outline.kind === "canvas"
      ? {
          layout: "canvas" as const,
          boards: outline.items.flatMap((item) => {
            const html = item.type === "board" ? bytesOf(item.file) : undefined
            return item.type === "board" && html
              ? [
                  {
                    id: item.id,
                    file: item.file,
                    w: item.w,
                    h: item.h,
                    html,
                    pictured: pictured.has(item.id),
                  },
                ]
              : []
          }),
          ...canvasOf(bytesOf(CANVAS_FILE)),
        }
      : layout && bytesOf(entry)
        ? { layout, entry: bytesOf(entry) as Uint8Array }
        : null
  let check: LayoutCheck | undefined
  let queries: CheckedQueries = { answers: {}, warnings: [] }
  if (
    checked &&
    checkDirectory &&
    pages &&
    (pages.layout !== "canvas" || pages.boards.length > 0)
  ) {
    queries = await checkedQueries(input.artifacts, published)
    signal.throwIfAborted()
    try {
      check = await checkLayout({
        handle,
        ...pages,
        directory: checkDirectory,
        files: checked.map((file) => file.path),
        // A revision's check: two updates of one open version never share their pictures.
        name: `${artifact.id}-r${version.revision}`,
        ...(theme && "theme" in theme ? { theme: theme.theme } : {}),
        queries: queries.answers,
        signal,
      })
    } catch (error) {
      if (signal.aborted) throw error
      console.warn("[SixbAgent] The layout check failed:", error)
      check = { status: "skipped", reason: "the check failed in the sandbox" }
    }
  }
  const previewWarnings =
    check?.status === "checked" && missing.length > 0
      ? await storePreviews({ input, handle, published, missing, checked: check.previews, signal })
      : []
  return {
    artifactId: artifact.id,
    // A new artifact, or a revision of one: what its summary and its row say.
    created: "kind" in request.target,
    version: version.version,
    revision: version.revision,
    // An Agent's write always leaves the version open: only the user creates a version.
    open: version.frozenAt === undefined,
    ...(published.merged ? { mergedSince: baseRevision ?? null } : {}),
    ...(installedRevision
      ? {}
      : { notInstalled: true, nextUpdateFrom: installed.revisionOf(artifact.id) ?? null }),
    kind: artifact.kind,
    title: version.title,
    warnings: [
      ...published.warnings,
      ...queries.warnings,
      ...(check?.status === "checked" ? check.warnings : []),
      ...previewWarnings,
    ].map(({ code, message, part }) => ({
      code,
      message,
      ...(part === undefined ? {} : { part }),
    })),
    ...(check === undefined
      ? {}
      : {
          layoutCheck:
            check.status === "checked"
              ? {
                  screenshots: [...check.screenshots],
                  ...(check.overview ? { overview: check.overview } : {}),
                }
              : { skipped: check.reason },
        }),
  }
}

/**
 * The files of a version merged with what others wrote, as its bytes; none when they cannot be
 * read, and the copy, the folder and the base of the next update then stay as they were.
 */
async function mergedFiles(
  input: PublishToolsInput,
  published: PublishedArtifact,
  signal: AbortSignal
): Promise<PublishedArtifactFile[] | undefined> {
  try {
    return await readArtifactVersionFiles(input.blobStorage, published.version, signal)
  } catch (error) {
    if (signal.aborted) throw error
    console.warn(
      `[SixbAgent] Could not read revision ${published.version.revision} of '${published.artifact.id}', merged:`,
      error
    )
    return undefined
  }
}

/**
 * The boards of the revision just written that miss a picture. A preview never costs a publish:
 * when they cannot be read, the check pictures none and the worker renders what is missing.
 */
async function missingPreviews(
  artifacts: Pick<AgentRunArtifacts, "missingPreviews">,
  published: PublishedArtifact
): Promise<readonly AgentRunMissingPreview[]> {
  try {
    return await artifacts.missingPreviews(writtenAt(published))
  } catch (error) {
    console.warn(
      `[SixbAgent] Could not read which boards of '${published.artifact.id}' miss a preview:`,
      error
    )
    return []
  }
}

/**
 * Hands the pictures the check took over as the revision's previews, and warns of each board one
 * of whose pictures was not kept: it shows its outline in that size and mode. The write exists by
 * now, so a failure is only logged: the worker renders what is still missing, and an update
 * written since gets its own.
 */
async function storePreviews(context: {
  readonly input: PublishToolsInput
  readonly handle: AgentSandboxHandle
  readonly published: PublishedArtifact
  readonly missing: readonly AgentRunMissingPreview[]
  readonly checked: readonly CheckedPreview[]
  readonly signal: AbortSignal
}): Promise<LayoutWarning[]> {
  const { input, published, signal } = context
  try {
    const { previews, dropped } = await storeCheckedPreviews({
      handle: context.handle,
      checked: context.checked,
      missing: context.missing,
      blobStorage: input.blobStorage,
      signal,
    })
    const refused = await input.artifacts.storePreviews({ ...writtenAt(published), previews })
    return unkeptPreviewWarnings([...dropped, ...refused])
  } catch (error) {
    if (signal.aborted) throw error
    console.warn(
      `[SixbAgent] Could not keep the previews of revision ${published.version.revision} of '${published.artifact.id}':`,
      error
    )
    return []
  }
}

/** The version a publish wrote, as it left its content. */
function writtenAt({ artifact, version }: PublishedArtifact) {
  return { artifactId: artifact.id, version: version.version, updatedAt: version.updatedAt }
}

/** One warning per board whose pictures were not all kept, naming each and why. */
function unkeptPreviewWarnings(unkept: readonly RefusedBoardPreview[]): LayoutWarning[] {
  const boards = [...new Set(unkept.map(({ board }) => board))]
  return boards.map((board) => {
    const pictures = unkept
      .filter((picture) => picture.board === board)
      .map(({ theme, size, reason }) => `the ${size} one in ${theme} mode (${reason})`)
    return {
      code: "preview_not_kept",
      part: board,
      message: `Board '${board}' has no preview for ${pictures.join(", ")}: readers see its outline there until they open it.`,
    }
  })
}

/** A canvas's items, for the check's picture of it as it opens; none when it cannot be read. */
function canvasOf(bytes: Uint8Array | undefined): { readonly canvas?: Canvas } {
  const parsed = bytes ? parseCanvas(new TextDecoder().decode(bytes)) : undefined
  return parsed && "canvas" in parsed ? { canvas: parsed.canvas } : {}
}

interface CheckedQueries {
  readonly answers: Readonly<Record<string, CheckedQuery>>
  readonly warnings: readonly LayoutWarning[]
}

/**
 * The version's queries, run as the requester, for the check to open the page with the rows a
 * reader like them gets: each as the API serializes it, since the page reads that JSON in the app.
 * Publishing checked each one as the requester, but what they may read can change before it runs,
 * and running can fail where checking could not: such a query is a warning, as the version exists.
 */
async function checkedQueries(
  reader: Pick<AgentRunArtifacts, "query">,
  published: PublishedArtifact
): Promise<CheckedQueries> {
  const { artifact, version } = published
  const answers = Object.entries(
    await answerArtifactQueries(version, (name) =>
      reader.query(artifact.id, name, { version: version.version })
    )
  )

  return {
    answers: Object.fromEntries(answers),
    warnings: answers.flatMap(([name, answer]) =>
      "error" in answer
        ? [
            {
              code: "query_failed",
              message: `Query '${name}' failed when the check ran it as you: ${answer.error.replace(/^\[Sixb\] /, "")} The page was checked with sixb.query("${name}") rejecting, as it does for every reader it fails for.`,
            },
          ]
        : []
    ),
  }
}

/** How storing refuses an artifact the requester may not publish to: as if it did not exist. */
const UNREACHABLE: ReadonlySet<string> = new Set(["artifact_not_found", "not_shared", "read_only"])

/**
 * The artifact to update: one the requester owns, or one this conversation shares that they take
 * part in. Another is refused as if it did not exist, even one they could update from another
 * conversation: writing it here would share it in this one.
 */
async function updatableArtifact(
  input: PublishToolsInput,
  artifactId: string,
  tool: ArtifactToolName,
  installed?: InstalledArtifacts
): Promise<ArtifactRecord> {
  const artifact = await input.artifacts.updatable(artifactId)
  if (artifact) return artifact

  // One installed to read is named as such: it exists, and the Agent was told it reads it.
  if (installed?.readOnly(artifactId)) {
    throw publishError(
      tool,
      `you can read artifact '${artifactId}' but not change it, so nothing was published`
    )
  }
  throw noArtifact(tool, artifactId)
}

function noArtifact(tool: ArtifactToolName, artifactId: string): AgentToolPublicError {
  return publishError(
    tool,
    `there is no artifact '${artifactId}'. $SIXB_ARTIFACTS lists this conversation's artifacts; to create a new one, leave out id and pass its kind`
  )
}

/**
 * The refusal for an update made from a copy the artifact has moved past, such as a person saving
 * in the app while the run works. What it moved to replaces the copy, so the Agent starts again
 * from it instead of writing over it.
 */
async function artifactMoved(
  input: PublishToolsInput,
  {
    installed,
    handle,
  }: { readonly installed: InstalledArtifacts; readonly handle: AgentSandboxHandle },
  { artifactId, baseRevision }: { readonly artifactId: string; readonly baseRevision: number },
  signal: AbortSignal
): Promise<AgentToolPublicError> {
  // Read as the requester: whatever moved it, it is a version they can read.
  const artifact = await updatableArtifact(input, artifactId, CREATE_TOOL)
  const latest = await input.artifacts.getVersion(artifactId, artifact.latestVersion)
  if (!latest) {
    throw new Error(`[SixbAgent] Version ${artifact.latestVersion} of '${artifactId}' is missing.`)
  }

  const named = (principal: Principal) =>
    principalsEqual(principal, input.owner) ? "its owner" : `${principal.type} '${principal.id}'`
  const author = named(latest.author)
  const where =
    latest.origin === undefined
      ? `by ${author} outside a conversation, such as in the app`
      : latest.origin.threadId === input.threadId
        ? "earlier in this conversation"
        : `by ${author} in another conversation`
  const created = latest.frozenBy
    ? `, and then created as a version by ${named(latest.frozenBy)}`
    : ""
  const moved = `artifact '${artifactId}' changed since revision ${baseRevision}, which you started from: it is at revision ${latest.revision}, whose version ${latest.version} was last written ${where}${created}, so nothing was published`

  let folder: string | undefined
  try {
    const files = await readArtifactVersionFiles(input.blobStorage, latest, signal)
    folder = await installed.replace(handle.sandbox, { artifact, version: latest }, files, signal, {
      edited: latest.origin?.threadId !== input.threadId,
    })
  } catch (error) {
    if (signal.aborted) throw error
    console.warn(
      `[SixbAgent] Could not install revision ${latest.revision} of artifact '${artifactId}':`,
      error
    )
    return publishError(
      CREATE_TOOL,
      `${moved}. Its revision ${latest.revision} could not be installed in the sandbox, so tell the user you could not build on it`
    )
  }

  return publishError(
    CREATE_TOOL,
    `${moved}. $SIXB_ARTIFACTS lists revision ${latest.revision}, installed under $SIXB_ARTIFACTS_DIR/${artifactId}/${folder ? ` and written into ${folder}, the folder you published it from` : ""}: start again from it as it is, keep its changes, make yours again, and publish it with its id`
  )
}

/**
 * Installs the artifact's latest version under `$SIXB_ARTIFACTS_DIR/<id>/`, as the requester reads
 * it: to read only, when they may not change it. Opening shares nothing: the conversation shares it
 * once the Agent updates it from that copy.
 */
async function open(
  input: PublishToolsInput,
  artifactId: string,
  signal: AbortSignal
): Promise<JsonValue> {
  signal.throwIfAborted()
  const artifact = await input.artifacts.get(artifactId)
  if (!artifact) throw publishError(OPEN_TOOL, `there is no artifact '${artifactId}' you can read`)

  const [installed, updatable, latest] = await Promise.all([
    input.installed,
    input.artifacts.updatable(artifactId),
    input.artifacts.getVersion(artifactId, artifact.latestVersion),
  ])
  if (!latest) {
    throw new Error(`[SixbAgent] Version ${artifact.latestVersion} of '${artifactId}' is missing.`)
  }

  const readOnly = updatable === null
  try {
    const { sandbox } = await input.resolveSandbox()
    const files = await readArtifactVersionFiles(input.blobStorage, latest, signal)
    await installed.replace(sandbox, { artifact, version: latest }, files, signal, {
      edited: latest.origin?.threadId !== input.threadId,
      readOnly,
    })
  } catch (error) {
    if (signal.aborted) throw error
    console.warn(
      `[SixbAgent] Could not install revision ${latest.revision} of artifact '${artifactId}':`,
      error
    )
    throw publishError(
      OPEN_TOOL,
      `its revision ${latest.revision} could not be installed in the sandbox, so tell the user you could not open it`
    )
  }

  const directory = installed.directoryOf(artifactId)
  return {
    artifactId,
    kind: artifact.kind,
    title: latest.title,
    version: latest.version,
    revision: latest.revision,
    readOnly,
    ...(directory ? { directory } : {}),
  }
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
/** The folder the files were published from, when they were a folder's: one file has none. */
function publishedFolder(
  handle: AgentSandboxHandle,
  path: string,
  sources: readonly PublishSource[]
): { readonly path: string; readonly absolute: string } | undefined {
  const absolute = resolveSandboxPath(handle, path)
  const inFolder = sources.every(
    (source) => source.absolutePath === posix.join(absolute, source.path)
  )
  return inFolder ? { path, absolute } : undefined
}

async function listSources(
  handle: AgentSandboxHandle,
  path: string,
  kind: ArtifactKind,
  tool: ArtifactToolName,
  signal: AbortSignal
): Promise<PublishSource[]> {
  let absolutePath: string
  try {
    absolutePath = resolveSandboxPath(handle, path)
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

/** What the Agent is told of an artifact it opened: where to read it, and whether it may change it. */
function openSummary(output: JsonValue): string {
  if (typeof output !== "object" || output === null || Array.isArray(output)) {
    return JSON.stringify(output)
  }

  const where =
    typeof output.directory === "string"
      ? `installed under ${output.directory}/`
      : "listed in $SIXB_ARTIFACTS, but too large to install"
  return [
    `Opened "${String(output.title)}": artifact ${String(output.artifactId)}, version ${String(output.version)} at revision ${String(output.revision)}, ${where}.`,
    output.readOnly === true
      ? "The user may read it but not change it: do not update it."
      : `To change it, edit a copy of that folder and call ${CREATE_TOOL} with this id: this conversation then shares it.`,
  ].join(" ")
}

function publishSummary(output: JsonValue): string {
  if (typeof output !== "object" || output === null || Array.isArray(output)) {
    return JSON.stringify(output)
  }
  const written = `artifact ${String(output.artifactId)}, version ${String(output.version)} at revision ${String(output.revision)}`
  const lines = [
    output.created === true
      ? `Published "${String(output.title)}" as ${written}.`
      : `Updated "${String(output.title)}": ${written}.`,
    output.open === false
      ? "The version is frozen."
      : `The version is open: each update replaces it until the user creates a version. To change it, call ${CREATE_TOOL} with this id.`,
  ]
  const copy = `$SIXB_ARTIFACTS_DIR/${String(output.artifactId)}/`
  const since =
    typeof output.mergedSince === "number"
      ? `, since revision ${output.mergedSince}, which you started from`
      : ""
  const from =
    typeof output.nextUpdateFrom === "number"
      ? `your next update starts from revision ${output.nextUpdateFrom} again`
      : "your next update starts from what it held before"
  if ("mergedSince" in output && output.notInstalled === true) {
    lines.push(
      `Merged with changes made meanwhile${since}, but the merged result could not be installed: your folder and ${copy} still hold your own files, and ${from}, so what others wrote stays. Read the version before editing what others may have changed, and say in your reply that others were editing it.`
    )
  } else if ("mergedSince" in output) {
    lines.push(
      `Merged with changes made meanwhile${since}: your folder now holds the merged result, as does ${copy}. Keep editing from it, and say in your reply that others were editing it.`
    )
  } else if (output.notInstalled === true) {
    lines.push(`This revision could not be installed in ${copy}: ${from}.`)
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
          ? `Layout check: the page as the reader sees it, in light mode or the mode its theme.json pins, is ${directory}/desktop.png at 1280px and ${directory}/phone.png at 390px, each its top 4000px. Open them with read, fix what the warnings name, and update the artifact.`
          : kind === "canvas"
            ? `Layout check: each board as the reader sees it, at its own size, in light mode or the mode its theme.json pins, is ${directory}/<id>.png (${screenshots.length} boards). Open them with read, fix what the warnings name, and update the artifact.${
                typeof check.overview === "string"
                  ? ` Open ${check.overview} to see the canvas as it opens, fitted to a 1440×900 window, and check that it reads at that zoom.`
                  : ""
              }`
            : `Layout check: each slide as the reader sees it, in light mode or the mode its theme.json pins, is ${directory}/slide-NN.png (${screenshots.length} slides). Open them with read, fix what the warnings name, and update the artifact.`
      )
    }
  }
  return lines.join("\n")
}

function parsePublishArtifactInput(value: unknown): PublishArtifactToolInput {
  const input = inputObject(value, CREATE_TOOL, ["path", "title", "kind", "id"])
  const kind = input.kind === undefined || input.kind === null ? undefined : input.kind
  if (kind !== undefined && !PUBLISHABLE_KINDS.includes(kind as PublishableKind)) {
    throw publishError(CREATE_TOOL, `kind must be one of ${PUBLISHABLE_KINDS.join(", ")}`)
  }
  // What a model sends for "no id": nothing, an empty string, or the word.
  const id = typeof input.id === "string" ? input.id.trim() : ""
  const noId = id === "" || /^(null|none|undefined)$/i.test(id)
  if (!noId && !isArtifactId(id)) {
    throw publishError(
      CREATE_TOOL,
      `id must be an artifact id such as art_k3m9q2x7tp. $SIXB_ARTIFACTS lists this conversation's artifacts; to create a new one, leave out id and pass its kind`
    )
  }
  if (noId && kind === undefined) {
    throw publishError(
      CREATE_TOOL,
      "pass kind to publish a new artifact, or the id of one to update it"
    )
  }
  const path = pathInput(input.path, CREATE_TOOL)
  const title = titleInput(input.title, CREATE_TOOL)
  // With an id, a kind is ignored: an update keeps the artifact's, and a model that sends every
  // field, as strict mode has it, fills one in.
  return noId
    ? { path, title, target: { kind: kind as PublishableKind } }
    : { path, title, target: { artifactId: id } }
}

function parseOpenArtifactInput(value: unknown): OpenArtifactToolInput {
  const input = inputObject(value, OPEN_TOOL, ["id"])
  const id = typeof input.id === "string" ? input.id.trim() : ""
  if (!isArtifactId(id)) {
    throw publishError(OPEN_TOOL, "id must be an artifact id such as art_k3m9q2x7tp")
  }
  return { id }
}

function inputObject(
  value: unknown,
  tool: ArtifactToolName,
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

function pathInput(value: unknown, tool: ArtifactToolName): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw publishError(tool, "path must be a file or directory in the sandbox")
  }
  return value
}

function titleInput(value: unknown, tool: ArtifactToolName): string {
  if (typeof value !== "string") throw publishError(tool, "title must be text")
  return value
}

/** Refusals the Agent can act on become its error text; anything else stays internal. */
function toPublishError(error: unknown, tool: ArtifactToolName, path?: string): unknown {
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

function publishError(tool: ArtifactToolName, message: string): AgentToolPublicError {
  const sentence = /[.!?]$/.test(message) ? message : `${message}.`
  return new AgentToolPublicError(`[SixbAgent] ${tool} refused: ${sentence}`)
}
