import { posix } from "node:path"
import type { ArtifactMedia, FileRef, SandboxFileRecord } from "@sixb/core"
import { formatArtifactAddress } from "@sixb/core/artifacts"
import type { AgentRunArtifacts, AgentRunFileStore } from "@sixb/core/internal/agents"
import { isMediaFile } from "@sixb/core/internal/artifacts/publish"
import type {
  ArtifactFile,
  ArtifactMediaPart,
  ArtifactOutline,
  ArtifactRecord,
  ArtifactVersionRecord,
} from "@sixb/core/storage"
import { NEVER_ABORTED_SIGNAL, waitForAbort } from "../abort"
import { downloadArtifactFiles, SANDBOX_INLINE_BYTES } from "../sandbox-files"
import type { AgentSandboxHandle } from "../sandbox-handle"

/** How many of the thread's artifacts are installed, newest first, and how many bytes in all. */
const MATERIALIZE_MAX_ARTIFACTS = 50
const MATERIALIZE_MAX_BYTES = 50 * 1024 * 1024
const REMOVE_TIMEOUT_MS = 30_000
// Removes the copy at $1, after moving the files named after $2 aside into $2, by their paths in
// the copy.
const REPLACE_COPY_SCRIPT = `set -eu
copy="$1"
staging="$2"
shift 2
rm -rf -- "$staging"
for path in "$@"; do
  mkdir -p -- "$(dirname -- "$staging/$path")"
  mv -- "$copy/$path" "$staging/$path"
done
rm -rf -- "$copy"`
/** Copying or fetching large files of a version, as it is installed. */
const COPY_TIMEOUT_MS = 10 * 60_000
/** Where a video's copy holds what is derived of its recordings: never published, as a dot-folder. */
const DERIVED_DIRECTORY = ".derived"

export interface MaterializedArtifacts {
  /** Files to write, at paths relative to the sandbox working directory or absolute. */
  readonly files: readonly SandboxFileRecord[]
  readonly manifestJson: string
}

/**
 * One file of a version to install: the bytes it holds; where the sandbox holds it already, for a
 * large one the sandbox uploaded itself, copied there; or its stored reference, read only once it
 * is written, and a large one fetched by the sandbox itself, never through the worker.
 */
export type PublishedArtifactFile =
  | { readonly path: string; readonly bytes: Uint8Array }
  | { readonly path: string; readonly sizeBytes: number; readonly sandboxPath: string }
  | { readonly path: string; readonly file: FileRef }

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
  /** A video's recordings, which its copy leaves in the API, each with what is derived of it. */
  readonly media?: readonly ManifestMedia[]
  /**
   * The latest version was last written outside this conversation: a person's edit in the app,
   * another conversation, or the project's code. An update starts from it and keeps its changes.
   */
  readonly edited?: true
  /** The requester reads it, through an object that holds it, and cannot change it. */
  readonly readOnly?: true
}

/**
 * A video's recording, as its manifest entry lists it: its original stays in the API, and the
 * Agent edits from what is derived of it. Its transcript and its cuts are written in the copy,
 * under `.derived/<path>/`, once they are ready; every other part downloads with
 * `sixb artifacts media`.
 */
interface ManifestMedia {
  readonly path: string
  readonly sizeBytes: number
  /** What it holds, once it is probed. */
  readonly durationMs?: number
  readonly video?: { readonly width: number; readonly height: number; readonly fps?: number }
  readonly audio?: true
  /** Where its transcript is, as JSON: `{ text, language?, words?, segments? }`, in milliseconds. */
  readonly transcript?: string
  /** Where its cuts are, as JSON: `{ atMs }`, each instant the picture cuts to another shot. */
  readonly cuts?: string
  /** Each part: `ready`, `pending`, or why it will not come. */
  readonly parts?: Readonly<Record<string, string>>
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
  /** The files of the revision each entry lists, by artifact id: what an update starts from. */
  readonly #bases = new Map<string, readonly ArtifactFile[]>()
  /**
   * The folder the Agent last published each artifact from, in the sandbox: it holds what the
   * installed copy holds, so its next update, from there, starts from the base.
   */
  readonly #folders = new Map<string, { readonly path: string; readonly absolute: string }>()
  #updates: Promise<unknown> = Promise.resolve()

  constructor(
    private readonly layout: {
      /** As the agent names it, like the manifest. */
      readonly directory: string
      readonly manifestPath: string
      readonly maxBytes: number
      /** Where a stored file it installs is read. */
      readonly blobStorage: AgentRunFileStore
      /** What is derived of a video's recordings, which its copy lists in their place. */
      readonly artifacts: MediaReader
    },
    entries: readonly ManifestEntry[],
    installed: Map<string, number>,
    readonly files: readonly SandboxFileRecord[],
    bases: ReadonlyMap<string, readonly ArtifactFile[]> = new Map()
  ) {
    this.#entries = entries
    this.#installed = installed
    for (const [id, base] of bases) this.#bases.set(id, base)
  }

  get manifestJson(): string {
    return manifestJson(this.#entries)
  }

  /** The revision the manifest lists for an artifact: the one its copy holds. */
  revisionOf(artifactId: string): number | undefined {
    return this.#entries.find((entry) => entry.id === artifactId)?.revision
  }

  /** Whether the artifact was installed for the requester to read only. */
  readOnly(artifactId: string): boolean {
    return this.#entries.find((entry) => entry.id === artifactId)?.readOnly === true
  }

  /** Where an artifact's copy is installed, as the agent names it; none when it is not. */
  directoryOf(artifactId: string): string | undefined {
    return this.#entries.find((entry) => entry.id === artifactId)?.directory
  }

  /**
   * The revision an update of an artifact starts from, and its files: those of the copy, which a
   * canvas's update is merged from when others wrote it since.
   */
  baseOf(
    artifactId: string
  ): { readonly revision: number; readonly files: readonly ArtifactFile[] } | undefined {
    const revision = this.revisionOf(artifactId)
    const files = this.#bases.get(artifactId)
    return revision === undefined || !files ? undefined : { revision, files }
  }

  /**
   * The files of an artifact's base that its copy leaves in the API, a video's recordings: an
   * update from the copy keeps those its scenes still play.
   */
  remoteOf(artifactId: string): readonly ArtifactFile[] {
    const kind = this.#entries.find((entry) => entry.id === artifactId)?.kind
    const files = this.#bases.get(artifactId) ?? []
    const remote = remotePaths(kind ?? "", files)
    return files.filter((file) => remote.has(file.path))
  }

  /** Records the folder the Agent published an artifact from: `path` as it named it. */
  publishedFrom(artifactId: string, folder: { readonly path: string; readonly absolute: string }) {
    this.#folders.set(artifactId, folder)
  }

  /**
   * Install a revision in place of the artifact's copy, and list it first: the copy, the base of
   * the next update, and the folder the Agent last published it from move together, so an update
   * from that folder never takes out what someone else wrote. One that fails to write them keeps
   * the base as it was, and rejects. One update runs at a time, so
   * parallel publishes never write an older manifest over a newer one. Resolves to the folder it
   * wrote, as the Agent named it, if any.
   */
  replace(
    handle: AgentSandboxHandle,
    published: { readonly artifact: ArtifactRecord; readonly version: ArtifactVersionRecord },
    files: readonly PublishedArtifactFile[],
    signal: AbortSignal,
    options: { readonly edited?: boolean; readonly readOnly?: boolean } = {}
  ): Promise<string | undefined> {
    const update = this.#updates.then(() =>
      this.#replace(handle, published, files, signal, options)
    )
    this.#updates = update.catch(() => {})
    return update
  }

  async #replace(
    handle: AgentSandboxHandle,
    {
      artifact,
      version,
    }: { readonly artifact: ArtifactRecord; readonly version: ArtifactVersionRecord },
    files: readonly PublishedArtifactFile[],
    signal: AbortSignal,
    options: { readonly edited?: boolean; readonly readOnly?: boolean }
  ): Promise<string | undefined> {
    const { sandbox } = handle
    const { directory: root, manifestPath, maxBytes } = this.layout
    const directory = posix.join(root, artifact.id)
    const inSandbox = (path: string) => posix.resolve(sandbox.workingDirectory, path)

    // A video's copy holds its scenes and what is derived of its recordings, which stay remote.
    const media =
      artifact.kind === "video"
        ? await videoMedia(this.layout.artifacts, artifact.id, version, signal)
        : undefined
    const remotePath = remotePaths(artifact.kind, version.files)
    const remote = (file: PublishedArtifactFile) => remotePath.has(file.path)
    const sizeBytes = [...files.filter((file) => !remote(file)), ...(media?.files ?? [])].reduce(
      (sum, file) => sum + publishedSize(file),
      0
    )
    let othersBytes = 0
    for (const [id, bytes] of this.#installed) if (id !== artifact.id) othersBytes += bytes
    const install = othersBytes + sizeBytes <= maxBytes

    // An artifact's directory holds exactly one revision: files an older one had must not linger.
    // A file the sandbox uploaded from that very directory is moved aside first, and copied back
    // from there: it is in no other place.
    const copyDirectory = inSandbox(directory)
    const staging = `${copyDirectory}.publishing`
    const inCopy = (file: PublishedArtifactFile) =>
      "sandboxPath" in file && file.sandboxPath.startsWith(`${copyDirectory}/`)
    const removed = await sandbox.runCommand(
      "bash",
      [
        "-c",
        REPLACE_COPY_SCRIPT,
        "replace",
        copyDirectory,
        staging,
        ...files.flatMap((file) =>
          "sandboxPath" in file && inCopy(file)
            ? [posix.relative(copyDirectory, file.sandboxPath)]
            : []
        ),
      ],
      { timeout: REMOVE_TIMEOUT_MS, signal }
    )
    if (removed.exitCode !== 0 || removed.timedOut) {
      throw new Error(
        `[SixbAgent] Could not remove ${directory}: ${removed.stderr.trim() || `exit ${removed.exitCode}`}`
      )
    }
    const sources = files.map((file) =>
      "sandboxPath" in file && inCopy(file)
        ? {
            ...file,
            sandboxPath: posix.join(staging, posix.relative(copyDirectory, file.sandboxPath)),
          }
        : file
    )
    // The copy, the folder and the base move together: until both are written, the next update
    // starts from the revision before, which the folder still holds.
    const previous = this.#bases.get(artifact.id) ?? []
    const entries = [
      manifestEntry(artifact, version, install ? directory : undefined, {
        ...options,
        ...(media ? { media: media.media } : {}),
      }),
      ...this.#entries.filter((entry) => entry.id !== artifact.id),
    ]
    const copy = install
      ? [...sources.filter((file) => !remote(file)), ...(media?.files ?? [])].map((file) => ({
          to: inSandbox(posix.join(directory, file.path)),
          file,
        }))
      : []
    await this.#write(handle, version, copy, signal, [
      { path: inSandbox(manifestPath), contents: manifestJson(entries) },
    ])

    const moved = await this.#writeFolder(handle, version, previous, sources, remote, signal)
    await sandbox
      .runCommand("bash", ["-c", 'rm -rf -- "$1"', "clear", staging], {
        timeout: REMOVE_TIMEOUT_MS,
        signal,
      })
      .catch(() => {})

    if (install) this.#installed.set(artifact.id, sizeBytes)
    else this.#installed.delete(artifact.id)
    this.#bases.set(artifact.id, version.files)
    this.#entries = entries
    return moved
  }

  /**
   * The folder the Agent last published an artifact from takes a revision too: each file as it
   * holds it, and none of the files the revision before held that it does not. Resolves to the
   * folder, as the Agent named it, if any.
   */
  async #writeFolder(
    handle: AgentSandboxHandle,
    version: ArtifactVersionRecord,
    previous: readonly ArtifactFile[],
    files: readonly PublishedArtifactFile[],
    remote: (file: PublishedArtifactFile) => boolean,
    signal: AbortSignal
  ): Promise<string | undefined> {
    const folder = this.#folders.get(version.artifactId)
    if (!folder) return undefined

    const kept = new Set(files.map((file) => file.path))
    const gone = previous
      .filter((file) => !kept.has(file.path))
      .map((file) => posix.join(folder.absolute, file.path))
    if (gone.length > 0) {
      const removedFiles = await handle.sandbox.runCommand(
        "bash",
        ["-c", 'rm -f -- "$@"', "rm", ...gone],
        { timeout: REMOVE_TIMEOUT_MS, signal }
      )
      if (removedFiles.exitCode !== 0 || removedFiles.timedOut) {
        throw new Error(
          `[SixbAgent] Could not update ${folder.path}: ${removedFiles.stderr.trim() || `exit ${removedFiles.exitCode}`}`
        )
      }
    }

    // The folder holds the revision before: a large file that did not change since is left as it
    // is there, and one the sandbox uploaded from this folder is there already. A recording a
    // video keeps in the API is never fetched: the folder keeps whatever it holds of it.
    const before = new Map(previous.map((file) => [file.path, file.file.digest]))
    const writes = files
      .map((file) => ({ to: posix.join(folder.absolute, file.path), file }))
      .filter(({ to, file }) =>
        "sandboxPath" in file
          ? file.sandboxPath !== to
          : !("file" in file) ||
            (!remote(file) &&
              (file.file.sizeBytes <= SANDBOX_INLINE_BYTES ||
                before.get(file.path) !== file.file.digest))
      )
    await this.#write(handle, version, writes, signal)
    return folder.path
  }

  /**
   * Writes each file of a version at its place in the sandbox, with `others` beside them: bytes
   * from here, a file the sandbox holds already copied there, a small stored one read from blob
   * storage, and a large one fetched by the sandbox from the API.
   */
  async #write(
    handle: AgentSandboxHandle,
    version: ArtifactVersionRecord,
    writes: readonly { readonly to: string; readonly file: PublishedArtifactFile }[],
    signal: AbortSignal,
    others: readonly SandboxFileRecord[] = []
  ): Promise<void> {
    const written: SandboxFileRecord[] = [...others]
    const copied: string[] = []
    const fetched: Parameters<typeof downloadArtifactFiles>[1][number][] = []
    for (const { to, file } of writes) {
      if ("bytes" in file) written.push({ path: to, contents: file.bytes })
      else if ("sandboxPath" in file) copied.push(file.sandboxPath, to)
      else if (file.file.sizeBytes <= SANDBOX_INLINE_BYTES) {
        written.push({
          path: to,
          contents: await readBlob(this.layout.blobStorage, file.file.blobId, signal),
        })
      } else {
        fetched.push({
          artifactId: version.artifactId,
          version: version.version,
          path: file.path,
          sizeBytes: file.file.sizeBytes,
          to,
        })
      }
    }

    if (copied.length > 0) {
      const result = await handle.sandbox.runCommand(
        "bash",
        [
          "-c",
          'while [ "$#" -gt 0 ]; do mkdir -p -- "$(dirname -- "$2")" && cp -- "$1" "$2"; shift 2; done',
          "copy",
          ...copied,
        ],
        { timeout: COPY_TIMEOUT_MS, signal }
      )
      if (result.exitCode !== 0 || result.timedOut) {
        throw new Error(
          `[SixbAgent] Could not copy the published files: ${result.stderr.trim() || `exit ${result.exitCode}`}`
        )
      }
    }
    await downloadArtifactFiles(handle, fetched, { signal, timeoutMs: COPY_TIMEOUT_MS })
    await handle.sandbox.writeFiles(written)
  }
}

function publishedSize(file: PublishedArtifactFile): number {
  if ("bytes" in file) return file.bytes.byteLength
  return "sandboxPath" in file ? file.sizeBytes : file.file.sizeBytes
}

/** What a turn reads of its conversation's artifacts, as its requester, through its session. */
export type TurnArtifacts = Pick<AgentRunArtifacts, "getVersion" | "list" | "turnWrites">

/** What is derived of a video's recordings, which its copy lists in their place. */
type MediaReader = Pick<AgentRunArtifacts, "media">

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
  readonly artifacts: TurnArtifacts & MediaReader
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
  const bases = new Map<string, readonly ArtifactFile[]>()
  const artifacts = await input.artifacts.list({ limit: MATERIALIZE_MAX_ARTIFACTS })
  let installedBytes = 0
  for (const artifact of artifacts) {
    signal.throwIfAborted()
    const version = await input.artifacts.getVersion(artifact.id, artifact.latestVersion)
    if (!version) continue

    // A video's copy holds its scenes and what is derived of its recordings, which stay remote.
    const media =
      artifact.kind === "video"
        ? await videoMedia(input.artifacts, artifact.id, version, signal)
        : undefined
    const remote = remotePaths(artifact.kind, version.files)
    const installing: InstalledFile[] = [
      ...version.files
        .filter((file) => !remote.has(file.path))
        .map(({ path, file }) => ({ path, file })),
      ...(media?.files ?? []),
    ]
    const sizeBytes = installing.reduce((sum, file) => sum + publishedSize(file), 0)
    const directory = posix.join(input.directory, artifact.id)
    let install = installedBytes + sizeBytes <= maxBytes
    if (install) {
      try {
        const copy: SandboxFileRecord[] = []
        for (const file of installing) {
          copy.push({
            path: posix.join(directory, file.path),
            contents:
              "bytes" in file
                ? file.bytes
                : await readBlob(input.blobStorage, file.file.blobId, signal),
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
    bases.set(artifact.id, version.files)
    // Edited when its last write came from anywhere but this conversation.
    entries.push(
      manifestEntry(artifact, version, install ? directory : undefined, {
        edited: version.origin?.threadId !== input.threadId,
        ...(media ? { media: media.media } : {}),
      })
    )
  }
  return new InstalledArtifacts(
    {
      directory: input.directory,
      manifestPath: input.manifestPath,
      maxBytes,
      blobStorage: input.blobStorage,
      artifacts: input.artifacts,
    },
    entries,
    installed,
    files,
    bases
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
  readonly handle: AgentSandboxHandle
  readonly signal: AbortSignal
}): Promise<string[]> {
  const [writes, artifacts] = await Promise.all([
    input.artifacts.turnWrites(),
    input.artifacts.list({ limit: MATERIALIZE_MAX_ARTIFACTS }),
  ])
  const written = new Set(writes.map((write) => write.artifactId))

  const failed: string[] = []
  const folders: string[] = []
  // Oldest first: each install lists its artifact first, so the newest ends up first.
  for (const artifact of [...artifacts].reverse()) {
    input.signal.throwIfAborted()
    if (!written.has(artifact.id)) continue
    if (input.installed.revisionOf(artifact.id) === artifact.revision) continue

    try {
      const version = await input.artifacts.getVersion(artifact.id, artifact.latestVersion)
      if (!version) continue
      const folder = await input.installed.replace(
        input.handle,
        { artifact, version },
        storedFiles(version),
        input.signal
      )
      if (folder) folders.push(folder)
    } catch (error) {
      input.signal.throwIfAborted()
      console.warn(`[SixbAgent] Could not install artifact '${artifact.id}':`, error)
      failed.push(artifact.id)
    }
  }
  if (failed.length > 0) {
    throw new Error(`[SixbAgent] Could not install artifacts ${failed.join(", ")}.`)
  }
  return folders
}

/** The manifest the sandbox reads, listing these entries. */
function manifestJson(entries: readonly ManifestEntry[]): string {
  return JSON.stringify({ artifacts: entries }, null, 2)
}

function manifestEntry(
  artifact: Pick<ArtifactRecord, "id" | "kind">,
  version: ArtifactVersionRecord,
  directory: string | undefined,
  {
    edited = false,
    readOnly = false,
    media,
  }: {
    readonly edited?: boolean
    readonly readOnly?: boolean
    /** A video's recordings, their derived files' paths relative to its copy. */
    readonly media?: readonly ManifestMedia[]
  } = {}
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
    ...(media ? { media: media.map((each) => installedMedia(each, directory)) } : {}),
    ...(edited ? { edited: true as const } : {}),
    ...(readOnly ? { readOnly: true as const } : {}),
  }
}

/** A recording as the manifest lists it: its derived files where the copy has them, if it is installed. */
function installedMedia(media: ManifestMedia, directory: string | undefined): ManifestMedia {
  const { transcript, cuts, ...rest } = media
  if (directory === undefined) return rest

  return {
    ...rest,
    ...(transcript ? { transcript: posix.join(directory, transcript) } : {}),
    ...(cuts ? { cuts: posix.join(directory, cuts) } : {}),
  }
}

/**
 * The paths of the files a version's copy leaves in the API: a video's recordings, which the Agent
 * looks at through what is derived of them, and edits around, never in.
 */
function remotePaths(kind: string, files: readonly ArtifactFile[]): ReadonlySet<string> {
  return new Set(kind === "video" ? files.filter(isMediaFile).map((file) => file.path) : [])
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
            : outline.kind === "video"
              ? outline.scenes.map((scene) =>
                  part(
                    scene.id,
                    `Scene ${scene.id}, ${scene.startMs / 1000}s to ${(scene.startMs + scene.durationMs) / 1000}s${scene.label ? `: ${scene.label}` : ""}`
                  )
                )
              : []
  return parts.length > 0 ? { parts } : {}
}

/** A file a copy installs from here: its bytes, or its stored reference, read as it is written. */
type InstalledFile =
  | { readonly path: string; readonly bytes: Uint8Array }
  | { readonly path: string; readonly file: FileRef }

/**
 * What is derived of each of a video's recordings, as its manifest entry lists it, and the files
 * its copy holds of them: each one's transcript and cuts, under `.derived/<path>/`. A recording
 * whose parts cannot be read is listed by its path alone.
 */
async function videoMedia(
  reader: MediaReader,
  artifactId: string,
  version: ArtifactVersionRecord,
  signal: AbortSignal
): Promise<{ readonly media: ManifestMedia[]; readonly files: InstalledFile[] }> {
  const media: ManifestMedia[] = []
  const files: InstalledFile[] = []

  for (const recording of version.files.filter(isMediaFile)) {
    signal.throwIfAborted()
    const { path } = recording
    const listed = { path, sizeBytes: recording.file.sizeBytes }

    let derived: ArtifactMedia | null
    try {
      derived = await reader.media(artifactId, { version: version.version, path })
    } catch (error) {
      signal.throwIfAborted()
      console.warn(
        `[SixbAgent] Could not read what is derived of '${path}' in artifact '${artifactId}':`,
        error
      )
      derived = null
    }
    if (!derived) {
      media.push(listed)
      continue
    }

    const { probe, transcript, cuts } = derived.parts
    const folder = posix.join(DERIVED_DIRECTORY, path)
    const written: { transcript?: string; cuts?: string } = {}
    if (transcript.status === "ready") {
      written.transcript = posix.join(folder, "transcript.json")
      files.push({ path: written.transcript, file: transcript.file })
    }
    if (cuts.status === "ready") {
      written.cuts = posix.join(folder, "cuts.json")
      files.push({
        path: written.cuts,
        bytes: new TextEncoder().encode(JSON.stringify({ atMs: cuts.atMs })),
      })
    }

    const probed = probe.status === "ready" ? probe : undefined
    media.push({
      ...listed,
      ...(probed ? { durationMs: probed.durationMs } : {}),
      ...(probed?.video
        ? {
            video: {
              width: probed.video.width,
              height: probed.video.height,
              ...(probed.video.fps === undefined ? {} : { fps: probed.video.fps }),
            },
          }
        : {}),
      ...(probed?.audio ? { audio: true as const } : {}),
      ...written,
      parts: Object.fromEntries(
        Object.entries(derived.parts).map(([name, part]) => [name, partStatus(part)])
      ),
    })
  }

  return { media, files }
}

/** `ready`, `pending`, or why a part will not come: `unavailable: <reason>`, `failed: <reason>`. */
function partStatus(part: ArtifactMediaPart<object>): string {
  return part.status === "ready" || part.status === "pending"
    ? part.status
    : `${part.status}: ${part.reason}`
}

/** A version's files as stored: each is read, or fetched by the sandbox, only once it is written. */
export function storedFiles(version: ArtifactVersionRecord): PublishedArtifactFile[] {
  return version.files.map(({ path, file }) => ({ path, file }))
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
