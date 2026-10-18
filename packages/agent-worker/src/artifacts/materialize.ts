import { posix } from "node:path"
import type { BlobStorage, Principal, Sandbox, SandboxFileRecord } from "@sixb/core"
import { formatArtifactAddress } from "@sixb/core/artifacts"
import type {
  ArtifactOutline,
  ArtifactRecord,
  ArtifactStorage,
  ArtifactVersionRecord,
} from "@sixb/core/storage"
import { NEVER_ABORTED_SIGNAL, waitForAbort } from "../abort"

/** How many of the thread's artifacts are installed, newest first, and how many bytes in all. */
const MATERIALIZE_MAX_ARTIFACTS = 50
const MATERIALIZE_MAX_BYTES = 50 * 1024 * 1024
const REMOVE_TIMEOUT_MS = 30_000

export interface MaterializedArtifacts {
  /** Files to write, at paths relative to the sandbox working directory. */
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
  /** The artifact's address: an artifact that shows it follows its latest version. */
  readonly address: string
  /** The same at this version, which never changes: a reply shows what its words describe. */
  readonly pinned: string
  /** Addresses of its parts: a document's sections, a sheet's sheets and charts, a deck's slides. */
  readonly parts?: readonly {
    readonly address: string
    readonly pinned: string
    readonly name: string
  }[]
  /** Where the version's files are, relative to the working directory; absent when not installed. */
  readonly directory?: string
  readonly files: readonly string[]
}

/**
 * The conversation's artifacts as the run's sandbox holds them: the latest version of each under
 * `<directory>/<id>/`, listed in the manifest, newest first. A publish replaces its artifact's copy
 * and entry, so both stay the latest version for the rest of the run: revising from the copy never
 * starts from the version before.
 */
export class InstalledArtifacts implements MaterializedArtifacts {
  #entries: readonly ManifestEntry[]
  /** The installed copies' sizes, by artifact id. */
  readonly #installed: Map<string, number>
  #updates: Promise<void> = Promise.resolve()

  constructor(
    private readonly layout: {
      /** Relative to the working directory, like the manifest. */
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

  /**
   * Install the version just published in place of the artifact's copy, and list it first. One
   * update runs at a time, so parallel publishes never write an older manifest over a newer one.
   */
  replace(
    sandbox: Sandbox,
    published: { readonly artifact: ArtifactRecord; readonly version: ArtifactVersionRecord },
    files: readonly PublishedArtifactFile[],
    signal: AbortSignal
  ): Promise<void> {
    const update = this.#updates.then(() => this.#replace(sandbox, published, files, signal))
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
    signal: AbortSignal
  ): Promise<void> {
    const { directory: root, manifestPath, maxBytes } = this.layout
    const directory = posix.join(root, artifact.id)
    const inSandbox = (path: string) => posix.join(sandbox.workingDirectory, path)
    const sizeBytes = files.reduce((sum, file) => sum + file.bytes.byteLength, 0)
    let othersBytes = 0
    for (const [id, bytes] of this.#installed) if (id !== artifact.id) othersBytes += bytes
    const install = othersBytes + sizeBytes <= maxBytes

    // A version's directory holds exactly that version: files an older one had must not linger.
    const removed = await sandbox.runCommand("bash", ["-c", 'rm -rf -- "$SIXB_ARTIFACT_COPY"'], {
      env: { SIXB_ARTIFACT_COPY: inSandbox(directory) },
      timeout: REMOVE_TIMEOUT_MS,
      signal,
    })
    if (removed.exitCode !== 0 || removed.timedOut) {
      throw new Error(
        `[SixbAgentWorker] Could not remove ${directory}: ${removed.stderr.trim() || `exit ${removed.exitCode}`}`
      )
    }
    if (install) this.#installed.set(artifact.id, sizeBytes)
    else this.#installed.delete(artifact.id)
    this.#entries = [
      manifestEntry(artifact, version, install ? directory : undefined),
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

/**
 * The latest version of each artifact the conversation published, installed under
 * `<directory>/<id>/` and listed in a manifest, so the Agent edits what was published rather than
 * whatever an older workspace still holds. Newest first; artifacts past the byte budget, or whose
 * files cannot be read, are listed without their files.
 */
export async function materializeThreadArtifacts(input: {
  readonly projectId: string
  readonly threadId: string
  readonly owner: Principal
  readonly storage: ArtifactStorage
  readonly blobStorage: BlobStorage
  /** Relative to the working directory. */
  readonly directory: string
  /** Where the manifest is written, relative to the working directory. */
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
  const { artifacts } = await input.storage.list({
    projectId: input.projectId,
    owner: input.owner,
    originThreadId: input.threadId,
    limit: MATERIALIZE_MAX_ARTIFACTS,
  })
  let installedBytes = 0
  for (const artifact of artifacts) {
    signal.throwIfAborted()
    const version = await input.storage.getVersion({
      projectId: input.projectId,
      artifactId: artifact.id,
      version: artifact.latestVersion,
    })
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
          `[SixbAgentWorker] Could not install version ${version.version} of artifact '${artifact.id}':`,
          error
        )
        install = false
      }
    }
    entries.push(manifestEntry(artifact, version, install ? directory : undefined))
  }
  return new InstalledArtifacts(
    { directory: input.directory, manifestPath: input.manifestPath, maxBytes },
    entries,
    installed,
    files
  )
}

function manifestEntry(
  artifact: Pick<ArtifactRecord, "id" | "kind">,
  version: ArtifactVersionRecord,
  directory: string | undefined
): ManifestEntry {
  return {
    id: artifact.id,
    kind: artifact.kind,
    title: version.title,
    version: version.version,
    address: formatArtifactAddress({ artifactId: artifact.id }),
    pinned: formatArtifactAddress({ artifactId: artifact.id, version: version.version }),
    ...partsOf(artifact.id, version.version, version.outline),
    ...(directory === undefined ? {} : { directory }),
    files: version.files.map((file) => file.path),
  }
}

/**
 * The parts an address can name, each with its address written out, so the Agent copies an
 * address instead of working out a heading's slug.
 */
function partsOf(
  artifactId: string,
  version: number,
  outline: ArtifactOutline
): { readonly parts?: ManifestEntry["parts"] } {
  const part = (name: string, label: string) => ({
    address: formatArtifactAddress({ artifactId, part: name }),
    pinned: formatArtifactAddress({ artifactId, version, part: name }),
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
                `Sheet ${sheet.name}: ${sheet.rows} rows; columns ${sheet.columns.join(", ")}`
              )
            ),
            ...outline.charts.map((chart) => part(`chart=${chart}`, `Chart ${chart}`)),
          ]
        : outline.kind === "slides"
          ? outline.slides.map((slide, index) =>
              part(String(index + 1), `Slide ${index + 1}${slide.title ? `: ${slide.title}` : ""}`)
            )
          : []
  return parts.length > 0 ? { parts } : {}
}

/** A blob's bytes. Reading stops when the run is cancelled. */
async function readBlob(
  blobStorage: BlobStorage,
  blobId: string,
  signal: AbortSignal
): Promise<Uint8Array> {
  const reader = (await waitForAbort(blobStorage.open(blobId), signal)).getReader()
  const cancel = () => void reader.cancel(signal.reason).catch(() => {})
  signal.addEventListener("abort", cancel, { once: true })
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
