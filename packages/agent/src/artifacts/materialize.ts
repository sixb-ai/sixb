import { posix } from "node:path"
import type { Sandbox, SandboxFileRecord } from "@sixb/core"
import { formatArtifactAddress } from "@sixb/core/artifacts"
import type { AgentRunArtifacts, AgentRunFileStore } from "@sixb/core/internal/agents"
import type { ArtifactOutline, ArtifactRecord, ArtifactVersionRecord } from "@sixb/core/storage"
import { NEVER_ABORTED_SIGNAL, waitForAbort } from "../abort"

/** How many of the thread's artifacts are installed, newest first, and how many bytes in all. */
const MATERIALIZE_MAX_ARTIFACTS = 50
const MATERIALIZE_MAX_BYTES = 50 * 1024 * 1024
const REMOVE_TIMEOUT_MS = 30_000

export interface MaterializedArtifacts {
  /** Files to write, at paths relative to the sandbox working directory or absolute. */
  readonly files: readonly SandboxFileRecord[]
  readonly manifestJson: string
}

/** One file of a version just published, with the bytes it holds. */
export interface PublishedArtifactFile {
  readonly path: string
  readonly bytes: Uint8Array
}

interface ManifestEntry {
  readonly id: string
  readonly kind: string
  readonly title: string
  readonly version: number
  /** The artifact's revision this copy holds: an update made from it starts from there. */
  readonly revision: number
  /**
   * The version is open: each update replaces it until the user creates a version. A frozen one
   * never changes, and the next update opens the next version.
   */
  readonly open: boolean
  /** The artifact's address: an artifact that shows it follows its latest version. */
  readonly address: string
  /**
   * The same at this version, once the user created it, which then never changes: a reply shows
   * what its words describe. None while the version is open.
   */
  readonly pinned?: string
  /**
   * Addresses of its parts: a document's sections, a sheet's sheets and charts, a deck's slides, a
   * canvas's boards and sections.
   */
  readonly parts?: readonly {
    readonly address: string
    readonly pinned?: string
    readonly name: string
  }[]
  /** Where the version's files are, as the agent names it; absent when not installed. */
  readonly directory?: string
  readonly files: readonly string[]
  /**
   * The latest version was last written outside this conversation: a person's edit in the app,
   * another conversation, or the project's code. An update starts from it and keeps its changes.
   */
  readonly edited?: true
}

/**
 * The conversation's artifacts as the run's sandbox holds them: the latest version of each under
 * `<directory>/<id>/`, listed in the manifest, newest first. A publish replaces its artifact's copy
 * and entry, so both stay at the latest revision for the rest of the run: revising from the copy
 * never starts from what the artifact held before. A publish refused because the artifact moved
 * on installs what it moved to.
 */
export class InstalledArtifacts implements MaterializedArtifacts {
  #entries: readonly ManifestEntry[]
  /** The installed copies' sizes, by artifact id. */
  readonly #installed: Map<string, number>
  #updates: Promise<void> = Promise.resolve()

  constructor(
    private readonly layout: {
      /** As the agent names it, like the manifest. */
      readonly directory: string
      readonly manifestPath: string
      readonly maxBytes: number
    },
    entries: readonly ManifestEntry[],
    installed: Map<string, number>,
    readonly files: readonly SandboxFileRecord[]
  ) {
    this.#entries = entries
    this.#installed = installed
  }

  get manifestJson(): string {
    return JSON.stringify({ artifacts: this.#entries }, null, 2)
  }

  /** The revision the manifest lists for an artifact: the one its copy holds. */
  revisionOf(artifactId: string): number | undefined {
    return this.#entries.find((entry) => entry.id === artifactId)?.revision
  }

  /**
   * Install the revision just written in place of the artifact's copy, and list it first. One
   * update runs at a time, so parallel publishes never write an older manifest over a newer one.
   */
  replace(
    sandbox: Sandbox,
    published: { readonly artifact: ArtifactRecord; readonly version: ArtifactVersionRecord },
    files: readonly PublishedArtifactFile[],
    signal: AbortSignal,
    options: { readonly edited?: boolean } = {}
  ): Promise<void> {
    const update = this.#updates.then(() =>
      this.#replace(sandbox, published, files, signal, options)
    )
    this.#updates = update.catch(() => {})
    return update
  }

  async #replace(
    sandbox: Sandbox,
    {
      artifact,
      version,
    }: { readonly artifact: ArtifactRecord; readonly version: ArtifactVersionRecord },
    files: readonly PublishedArtifactFile[],
    signal: AbortSignal,
    options: { readonly edited?: boolean }
  ): Promise<void> {
    const { directory: root, manifestPath, maxBytes } = this.layout
    const directory = posix.join(root, artifact.id)
    const inSandbox = (path: string) => posix.resolve(sandbox.workingDirectory, path)
    const sizeBytes = files.reduce((sum, file) => sum + file.bytes.byteLength, 0)
    let othersBytes = 0
    for (const [id, bytes] of this.#installed) if (id !== artifact.id) othersBytes += bytes
    const install = othersBytes + sizeBytes <= maxBytes

    // An artifact's directory holds exactly one revision: files an older one had must not linger.
    const removed = await sandbox.runCommand("bash", ["-c", 'rm -rf -- "$SIXB_ARTIFACT_COPY"'], {
      env: { SIXB_ARTIFACT_COPY: inSandbox(directory) },
      timeout: REMOVE_TIMEOUT_MS,
      signal,
    })
    if (removed.exitCode !== 0 || removed.timedOut) {
      throw new Error(
        `[SixbAgent] Could not remove ${directory}: ${removed.stderr.trim() || `exit ${removed.exitCode}`}`
      )
    }
    if (install) this.#installed.set(artifact.id, sizeBytes)
    else this.#installed.delete(artifact.id)
    this.#entries = [
      manifestEntry(artifact, version, install ? directory : undefined, options),
      ...this.#entries.filter((entry) => entry.id !== artifact.id),
    ]
    await sandbox.writeFiles([
      ...(install
        ? files.map((file) => ({
            path: inSandbox(posix.join(directory, file.path)),
            contents: file.bytes,
          }))
        : []),
      { path: inSandbox(manifestPath), contents: this.manifestJson },
    ])
  }
}

/** What a turn reads of its conversation's artifacts, as its requester, through its session. */
export type TurnArtifacts = Pick<AgentRunArtifacts, "getVersion" | "list" | "turnWrites">

/**
 * The latest version of each artifact the conversation shares, installed under `<directory>/<id>/`
 * and listed in a manifest, so the Agent edits what was published rather than whatever an older
 * workspace still holds. Read as the turn's requester, it holds nothing they cannot read. Newest
 * first; artifacts past the byte budget, or whose files cannot be read, are listed without their
 * files.
 */
export async function materializeThreadArtifacts(input: {
  /** The conversation's thread, whose artifacts a copy published elsewhere is edited from. */
  readonly threadId: string
  readonly artifacts: TurnArtifacts
  readonly blobStorage: AgentRunFileStore
  /** As the agent names it: relative to the working directory, or absolute. */
  readonly directory: string
  /** Where the manifest is written, named the same way. */
  readonly manifestPath: string
  /** A cancelled run stops downloading. */
  readonly signal?: AbortSignal
  /** Test seam; production installs up to 50 MB. */
  readonly maxBytes?: number
}): Promise<InstalledArtifacts> {
  const signal = input.signal ?? NEVER_ABORTED_SIGNAL
  const maxBytes = input.maxBytes ?? MATERIALIZE_MAX_BYTES
  const entries: ManifestEntry[] = []
  const files: SandboxFileRecord[] = []
  const installed = new Map<string, number>()
  const artifacts = await input.artifacts.list({ limit: MATERIALIZE_MAX_ARTIFACTS })
  let installedBytes = 0
  for (const artifact of artifacts) {
    signal.throwIfAborted()
    const version = await input.artifacts.getVersion(artifact.id, artifact.latestVersion)
    if (!version) continue
    const sizeBytes = version.files.reduce((sum, file) => sum + file.file.sizeBytes, 0)
    const directory = posix.join(input.directory, artifact.id)
    let install = installedBytes + sizeBytes <= maxBytes
    if (install) {
      try {
        const copy: SandboxFileRecord[] = []
        for (const file of version.files) {
          copy.push({
            path: posix.join(directory, file.path),
            contents: await readBlob(input.blobStorage, file.file.blobId, signal),
          })
        }
        files.push(...copy)
        installedBytes += sizeBytes
        installed.set(artifact.id, sizeBytes)
      } catch (error) {
        signal.throwIfAborted()
        // One unreadable blob must not cost every later run of the thread its sandbox.
        console.warn(
          `[SixbAgent] Could not install revision ${version.revision} of artifact '${artifact.id}':`,
          error
        )
        install = false
      }
    }
    // Edited when its last write came from anywhere but this conversation.
    entries.push(
      manifestEntry(artifact, version, install ? directory : undefined, {
        edited: version.origin?.threadId !== input.threadId,
      })
    )
  }
  return new InstalledArtifacts(
    { directory: input.directory, manifestPath: input.manifestPath, maxBytes },
    entries,
    installed,
    files
  )
}

/**
 * Install the latest revision of each thread artifact the run's turn wrote, its children's writes
 * among them, in place of the copy the run holds when it holds another: a parent turn sees what
 * its children wrote like its own, whoever wrote since. One that cannot be installed does not stop
 * the others; the error at the end names each.
 */
export async function installTurnArtifacts(input: {
  readonly installed: InstalledArtifacts
  readonly artifacts: TurnArtifacts
  readonly blobStorage: AgentRunFileStore
  readonly sandbox: Sandbox
  readonly signal: AbortSignal
}): Promise<void> {
  const [writes, artifacts] = await Promise.all([
    input.artifacts.turnWrites(),
    input.artifacts.list({ limit: MATERIALIZE_MAX_ARTIFACTS }),
  ])
  const written = new Set(writes.map((write) => write.artifactId))

  const failed: string[] = []
  // Oldest first: each install lists its artifact first, so the newest ends up first.
  for (const artifact of [...artifacts].reverse()) {
    input.signal.throwIfAborted()
    if (!written.has(artifact.id)) continue
    if (input.installed.revisionOf(artifact.id) === artifact.revision) continue

    try {
      const version = await input.artifacts.getVersion(artifact.id, artifact.latestVersion)
      if (!version) continue
      const files = await readArtifactVersionFiles(input.blobStorage, version, input.signal)
      await input.installed.replace(input.sandbox, { artifact, version }, files, input.signal)
    } catch (error) {
      input.signal.throwIfAborted()
      console.warn(`[SixbAgent] Could not install artifact '${artifact.id}':`, error)
      failed.push(artifact.id)
    }
  }
  if (failed.length > 0) {
    throw new Error(`[SixbAgent] Could not install artifacts ${failed.join(", ")}.`)
  }
}

function manifestEntry(
  artifact: Pick<ArtifactRecord, "id" | "kind">,
  version: ArtifactVersionRecord,
  directory: string | undefined,
  { edited = false }: { readonly edited?: boolean } = {}
): ManifestEntry {
  // Only a frozen version is pinned: an open one changes with every update.
  const pinnedAt = version.frozenAt ? version.version : undefined
  return {
    id: artifact.id,
    kind: artifact.kind,
    title: version.title,
    version: version.version,
    revision: version.revision,
    open: version.frozenAt === undefined,
    address: formatArtifactAddress({ artifactId: artifact.id }),
    ...(pinnedAt === undefined
      ? {}
      : { pinned: formatArtifactAddress({ artifactId: artifact.id, version: pinnedAt }) }),
    ...partsOf(artifact.id, pinnedAt, version.outline),
    ...(directory === undefined ? {} : { directory }),
    files: version.files.map((file) => file.path),
    ...(edited ? { edited: true as const } : {}),
  }
}

/**
 * The parts an address can name, each with its address written out, so the Agent copies an
 * address instead of working out a heading's slug; pinned too in a frozen version.
 */
function partsOf(
  artifactId: string,
  pinnedAt: number | undefined,
  outline: ArtifactOutline
): { readonly parts?: ManifestEntry["parts"] } {
  const part = (name: string, label: string) => ({
    address: formatArtifactAddress({ artifactId, part: name }),
    ...(pinnedAt === undefined
      ? {}
      : { pinned: formatArtifactAddress({ artifactId, version: pinnedAt, part: name }) }),
    name: label,
  })
  const parts =
    outline.kind === "document"
      ? outline.headings
          .filter((heading) => heading.depth <= 3)
          .map((heading) => part(heading.slug, heading.text))
      : outline.kind === "sheet"
        ? [
            ...outline.sheets.map((sheet) =>
              part(
                sheet.name,
                // A live sheet's rows are each reader's, read by its query: it has no count.
                `Sheet ${sheet.name}: ${sheet.query === undefined ? `${sheet.rows} rows` : `live rows of query ${sheet.query}`}; columns ${sheet.columns.join(", ")}`
              )
            ),
            ...outline.charts.map((chart) => part(`chart=${chart}`, `Chart ${chart}`)),
          ]
        : outline.kind === "slides"
          ? outline.slides.map((slide, index) =>
              part(String(index + 1), `Slide ${index + 1}${slide.title ? `: ${slide.title}` : ""}`)
            )
          : outline.kind === "canvas"
            ? outline.items.map((item) =>
                part(
                  item.id,
                  `${item.type === "board" ? "Board" : "Section"} ${item.id}${item.title ? `: ${item.title}` : ""}`
                )
              )
            : []
  return parts.length > 0 ? { parts } : {}
}

/** A version's files with the bytes each holds. Reading stops when the run is cancelled. */
export async function readArtifactVersionFiles(
  blobStorage: AgentRunFileStore,
  version: ArtifactVersionRecord,
  signal: AbortSignal
): Promise<PublishedArtifactFile[]> {
  const files: PublishedArtifactFile[] = []

  for (const file of version.files) {
    files.push({ path: file.path, bytes: await readBlob(blobStorage, file.file.blobId, signal) })
  }

  return files
}

/** A blob's bytes. Reading stops when the run is cancelled. */
export async function readBlob(
  blobStorage: AgentRunFileStore,
  blobId: string,
  signal: AbortSignal
): Promise<Uint8Array> {
  const reader = (await waitForAbort(blobStorage.open(blobId), signal)).getReader()
  const cancel = () => void reader.cancel(signal.reason).catch(() => {})
  signal.addEventListener("abort", cancel, { once: true })
  // A cancel between the open and the listener fires no event.
  if (signal.aborted) cancel()
  try {
    const chunks: Uint8Array[] = []
    for (;;) {
      const { done, value } = await reader.read()
      signal.throwIfAborted()
      if (done) return Buffer.concat(chunks)
      chunks.push(value)
    }
  } finally {
    signal.removeEventListener("abort", cancel)
    reader.releaseLock()
  }
}
