import { type Principal, principalsEqual, SYSTEM_PRINCIPAL } from "../auth"
import type { BlobStorage } from "../blob-storage/types"
import { resolveRuntimeAuthorizationForProject } from "../execution/authorization"
import type { SixbRuntimeContext } from "../runtime/types"
import type {
  ArtifactFile,
  ArtifactRecord,
  ArtifactStorage,
  ArtifactVersionRecord,
  ListArtifactsResult,
  ListArtifactVersionsResult,
} from "../storage/artifacts/types"
import { ArtifactRequestError } from "./errors"
import type { ArtifactKind } from "./kinds"
import { type PublishedArtifact, publishArtifact } from "./publish/publish"

/** A version's content: what its kind renders from, and what it is called. */
export interface ArtifactContentInput {
  readonly kind: ArtifactKind
  readonly title: string
  /** Files stored with `sixb.blobs.put()` or `POST /api/files`, at their paths in the artifact. */
  readonly files: readonly ArtifactFile[]
}

export interface ListArtifactsRuntimeInput {
  /** Only artifacts with a version the Agent published in this thread. */
  readonly threadId?: string
  /** Only artifacts of this kind. */
  readonly kind?: ArtifactKind
  readonly limit?: number
  readonly offset?: number
}

/**
 * Artifacts the caller owns: create one, publish its next version, read it back. A user or service
 * account reaches only its own artifacts; system code reaches every artifact in the project.
 */
export interface ArtifactsRuntime {
  /** Creates an artifact owned by the caller, with its first version. */
  create(input: ArtifactContentInput): Promise<PublishedArtifact>
  /** Publishes the next version. The kind must be the artifact's. */
  publish(artifactId: string, input: ArtifactContentInput): Promise<PublishedArtifact>
  get(artifactId: string): Promise<ArtifactRecord | null>
  /** Most recently updated first. */
  list(input?: ListArtifactsRuntimeInput): Promise<ListArtifactsResult>
  getVersion(artifactId: string, version: number | "latest"): Promise<ArtifactVersionRecord | null>
  /** Newest first; `null` when the artifact is not the caller's. */
  listVersions(
    artifactId: string,
    input?: { readonly limit?: number; readonly offset?: number }
  ): Promise<ListArtifactVersionsResult | null>
  /** Deletes the artifact with every version. `false` when it is not the caller's. */
  delete(artifactId: string): Promise<boolean>
}

export function createArtifactsRuntime(
  runtime: SixbRuntimeContext,
  blobStorage: BlobStorage
): ArtifactsRuntime {
  const authority = resolveRuntimeAuthorizationForProject(runtime)
  // Shared-link sessions and unresolved authority reach no artifact.
  const caller: Principal | null =
    authority.type === "principal"
      ? authority.context.principal
      : authority.type === "unrestricted"
        ? SYSTEM_PRINCIPAL
        : null
  const ownerFilter = authority.type === "principal" ? caller : null

  const requireStorage = (): ArtifactStorage => {
    const storage = runtime.storage.artifacts
    if (!storage) {
      throw new ArtifactRequestError(
        "storage_unavailable",
        "[Sixb] Artifacts need storage that supports them."
      )
    }
    return storage
  }
  const requireCaller = (): Principal => {
    if (!caller) {
      throw new ArtifactRequestError("not_allowed", "[Sixb] This caller cannot publish artifacts.")
    }
    return caller
  }
  const visible = (artifact: ArtifactRecord | null): ArtifactRecord | null =>
    artifact && caller && (!ownerFilter || principalsEqual(ownerFilter, artifact.owner))
      ? artifact
      : null
  const getVisible = async (artifactId: string): Promise<ArtifactRecord | null> =>
    caller
      ? visible(await requireStorage().get({ projectId: runtime.projectId, id: artifactId }))
      : null

  return {
    async create(input) {
      return publishArtifact(
        { projectId: runtime.projectId, storage: requireStorage(), blobStorage },
        { ...input, author: requireCaller() }
      )
    },

    async publish(artifactId, input) {
      const author = requireCaller()
      if (!(await getVisible(artifactId))) throw notFound(artifactId)
      return publishArtifact(
        { projectId: runtime.projectId, storage: requireStorage(), blobStorage },
        { ...input, artifactId, author }
      )
    },

    get: getVisible,

    async list(input = {}) {
      if (!caller) return { artifacts: [], hasMore: false, total: 0 }
      return requireStorage().list({
        projectId: runtime.projectId,
        ...(ownerFilter ? { owner: ownerFilter } : {}),
        ...(input.threadId === undefined ? {} : { originThreadId: input.threadId }),
        ...(input.kind === undefined ? {} : { kind: input.kind }),
        ...(input.limit === undefined ? {} : { limit: input.limit }),
        ...(input.offset === undefined ? {} : { offset: input.offset }),
      })
    },

    async getVersion(artifactId, version) {
      const artifact = await getVisible(artifactId)
      if (!artifact) return null
      return requireStorage().getVersion({
        projectId: runtime.projectId,
        artifactId,
        version: version === "latest" ? artifact.latestVersion : version,
      })
    },

    async listVersions(artifactId, input = {}) {
      if (!(await getVisible(artifactId))) return null
      return requireStorage().listVersions({ projectId: runtime.projectId, artifactId, ...input })
    },

    async delete(artifactId) {
      if (!(await getVisible(artifactId))) return false
      return requireStorage().delete({ projectId: runtime.projectId, id: artifactId })
    },
  }
}

function notFound(artifactId: string): ArtifactRequestError {
  return new ArtifactRequestError(
    "artifact_not_found",
    `[Sixb] Artifact '${artifactId}' was not found.`
  )
}
