import { posix } from "node:path"
import type { BlobStorage, Principal, SandboxFileRecord } from "@sixb/core"
import type { ArtifactStorage } from "@sixb/core/storage"

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
        ...(install ? { directory } : {}),
        files: version.files.map((file) => file.path),
      })
    }
  }
  return { files, manifestJson: JSON.stringify({ artifacts: entries }, null, 2) }
}
