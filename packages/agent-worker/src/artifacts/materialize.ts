import { posix } from "node:path"
import type { BlobStorage, Principal, SandboxFileRecord } from "@sixb/core"
import { formatArtifactAddress } from "@sixb/core/artifacts"
import type { ArtifactOutline, ArtifactStorage } from "@sixb/core/storage"

/** How many of the thread's artifacts are installed, newest first, and how many bytes in all. */
const MATERIALIZE_MAX_ARTIFACTS = 50
const MATERIALIZE_MAX_BYTES = 50 * 1024 * 1024

export interface MaterializedArtifacts {
  /** Files to write, at paths relative to the sandbox working directory. */
  readonly files: readonly SandboxFileRecord[]
  readonly manifestJson: string
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
  /** Addresses of its parts: a document's sections, a sheet's sheets and charts. */
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
 * The latest version of each artifact the conversation published, installed under
 * `<directory>/<id>/` and listed in a manifest, so the Agent edits what was published rather than
 * whatever an older workspace still holds. Newest first; artifacts past the byte budget are listed
 * without their files.
 */
export async function materializeThreadArtifacts(input: {
  readonly projectId: string
  readonly threadId: string
  readonly owner: Principal
  readonly storage: ArtifactStorage | undefined
  readonly blobStorage: BlobStorage
  /** Relative to the working directory. */
  readonly directory: string
  readonly signal?: AbortSignal
  /** Test seam; production installs up to 50 MB. */
  readonly maxBytes?: number
}): Promise<MaterializedArtifacts> {
  const maxBytes = input.maxBytes ?? MATERIALIZE_MAX_BYTES
  const entries: ManifestEntry[] = []
  const files: SandboxFileRecord[] = []
  if (input.storage) {
    const { artifacts } = await input.storage.list({
      projectId: input.projectId,
      owner: input.owner,
      originThreadId: input.threadId,
      limit: MATERIALIZE_MAX_ARTIFACTS,
    })
    let installedBytes = 0
    for (const artifact of artifacts) {
      input.signal?.throwIfAborted()
      const version = await input.storage.getVersion({
        projectId: input.projectId,
        artifactId: artifact.id,
        version: artifact.latestVersion,
      })
      if (!version) continue
      const sizeBytes = version.files.reduce((sum, file) => sum + file.file.sizeBytes, 0)
      const install = installedBytes + sizeBytes <= maxBytes
      const directory = posix.join(input.directory, artifact.id)
      if (install) {
        installedBytes += sizeBytes
        for (const file of version.files) {
          const body = await input.blobStorage.open(file.file.blobId)
          files.push({
            path: posix.join(directory, file.path),
            contents: new Uint8Array(await new Response(body).arrayBuffer()),
          })
        }
      }
      entries.push({
        id: artifact.id,
        kind: artifact.kind,
        title: version.title,
        version: version.version,
        address: formatArtifactAddress({ artifactId: artifact.id }),
        pinned: formatArtifactAddress({ artifactId: artifact.id, version: version.version }),
        ...partsOf(artifact.id, version.version, version.outline),
        ...(install ? { directory } : {}),
        files: version.files.map((file) => file.path),
      })
    }
  }
  return { files, manifestJson: JSON.stringify({ artifacts: entries }, null, 2) }
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
        : []
  return parts.length > 0 ? { parts } : {}
}
