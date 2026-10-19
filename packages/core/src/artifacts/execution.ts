import { type Principal, principalsEqual, SYSTEM_PRINCIPAL } from "../auth"
import type { BlobStorage } from "../blob-storage/types"
import { resolveRuntimeAuthorizationForProject } from "../execution/authorization"
import type { SixbRuntimeContext } from "../runtime/types"
import { ArtifactStorageError } from "../storage/artifacts/errors"
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
import { ARTIFACT_STATE_LIMITS } from "./limits"
import { type PublishedArtifact, publishArtifact } from "./publish/publish"

/** A version's content: what its kind renders from, and what it is called. */
export interface ArtifactContentInput {
  readonly kind: ArtifactKind
  readonly title: string
  /** Files stored with `sixb.blobs.put()` or `POST /api/files`, at their paths in the artifact. */
  readonly files: readonly ArtifactFile[]
}

export interface PublishArtifactRuntimeInput extends ArtifactContentInput {
  /**
   * The version this one was made from, such as the one a person edited. When another version was
   * published since, publishing fails with `artifact_moved`, naming the latest and its author.
   */
  readonly baseVersion?: number
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
  publish(artifactId: string, input: PublishArtifactRuntimeInput): Promise<PublishedArtifact>
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
  /**
   * What the artifact keeps for the caller as its reader, as a page keeps it with `sixb.state`:
   * JSON values by key, across its versions. Each call throws `artifact_not_found` when the
   * artifact is not the caller's.
   */
  state(artifactId: string): ArtifactStateRuntime
}

/** One reader's values, kept by one artifact. */
export interface ArtifactStateRuntime {
  /** The value under the key, or undefined when there is none. */
  get(key: string): Promise<unknown>
  /**
   * Keeps a JSON value under the key, replacing one there. Throws `invalid_state` for a key or a
   * value that is not one, and `state_full` past `ARTIFACT_STATE_LIMITS`. Returns what it kept.
   */
  set(key: string, value: unknown): Promise<ArtifactStateValue>
  /** `false` when there was no value under the key. */
  delete(key: string): Promise<boolean>
  /** Every value, by key in order. */
  entries(): Promise<ArtifactStateValue[]>
  /** Deletes every value, and returns how many. */
  clear(): Promise<number>
}

export interface ArtifactStateValue {
  readonly key: string
  readonly value: unknown
  readonly updatedAt: Date
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

    state(artifactId) {
      // The reader is the caller; the artifact must be one they can open.
      const scope = async () => {
        const principal = requireCaller()
        if (!(await getVisible(artifactId))) throw notFound(artifactId)
        return { projectId: runtime.projectId, artifactId, principal }
      }
      return {
        async get(key) {
          const entry = await requireStorage().getState({ ...(await scope()), key: stateKey(key) })
          return entry ? JSON.parse(entry.value) : undefined
        },
        async set(key, value) {
          const at = { ...(await scope()), key: stateKey(key) }
          const text = stateValue(value)
          const updatedAt = new Date()
          try {
            await requireStorage().setState({ ...at, value: text, updatedAt })
          } catch (error) {
            if (error instanceof ArtifactStorageError && error.code === "artifact_state_full") {
              throw new ArtifactRequestError("state_full", error.message)
            }
            throw error
          }
          // As read back: what JSON keeps of it.
          return { key: at.key, value: JSON.parse(text), updatedAt }
        },
        async delete(key) {
          return requireStorage().deleteState({ ...(await scope()), key: stateKey(key) })
        },
        async entries() {
          const entries = await requireStorage().listState(await scope())
          return entries.map((entry) => ({
            key: entry.key,
            value: JSON.parse(entry.value),
            updatedAt: entry.updatedAt,
          }))
        },
        async clear() {
          return requireStorage().clearState(await scope())
        },
      }
    },
  }
}

/** A key a page names a value by: a short line of text. */
function stateKey(key: string): string {
  if (
    typeof key !== "string" ||
    key.length === 0 ||
    key.length > ARTIFACT_STATE_LIMITS.maxKeyLength ||
    /\p{Cc}/u.test(key)
  ) {
    throw new ArtifactRequestError(
      "invalid_state",
      `[Sixb] A key is 1 to ${ARTIFACT_STATE_LIMITS.maxKeyLength} characters on one line, such as "filters".`
    )
  }
  return key
}

/** A value as JSON text, refused when JSON has no way to write it. */
function stateValue(value: unknown): string {
  let text: string | undefined
  try {
    text = JSON.stringify(value)
  } catch {
    text = undefined
  }
  if (text === undefined) {
    throw new ArtifactRequestError(
      "invalid_state",
      "[Sixb] A page keeps JSON values: text, numbers, true and false, null, lists, and objects of them."
    )
  }
  return text
}

function notFound(artifactId: string): ArtifactRequestError {
  return new ArtifactRequestError(
    "artifact_not_found",
    `[Sixb] Artifact '${artifactId}' was not found.`
  )
}
