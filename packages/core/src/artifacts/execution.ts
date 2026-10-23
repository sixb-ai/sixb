import { createAgentThreadAccessRule } from "../agents/thread-access"
import { type Principal, SYSTEM_PRINCIPAL } from "../auth"
import { isRuntimeAllowed } from "../authorization"
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
import type { Storage } from "../storage/types"
import {
  type ArtifactAccess,
  type ArtifactAccessRule,
  assertUpdatable,
  createArtifactAccessRule,
} from "./access"
import { ArtifactRequestError } from "./errors"
import type { ArtifactKind } from "./kinds"
import { ARTIFACT_STATE_LIMITS } from "./limits"
import {
  artifactVersionWarnings,
  type PreparedArtifactVersion,
  type PublishedArtifact,
  prepareArtifactVersion,
  publishArtifact,
  storeArtifactVersion,
} from "./publish/publish"
import { type ArtifactQueryChecker, createArtifactQueryChecker } from "./publish/queries"

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
  /**
   * Only the artifacts a conversation shares: every one of them, whoever owns it, for whoever reads
   * the conversation; otherwise the caller's own among them.
   */
  readonly threadId?: string
  /** Only artifacts of this kind. */
  readonly kind?: ArtifactKind
  readonly limit?: number
  readonly offset?: number
}

/**
 * The artifacts the caller reaches: its own, and those shared in a conversation it reads, as
 * {@link ArtifactAccess} says. System code reaches every artifact in the project, and an access
 * token only its own.
 */
export interface ArtifactsRuntime {
  /** Creates an artifact owned by the caller, with its first version. */
  create(input: ArtifactContentInput): Promise<PublishedArtifact>
  /**
   * Publishes the next version, authored by the caller; the artifact keeps its owner. The kind must
   * be the artifact's. Throws `not_shared` or `read_only` when the caller may not update it.
   */
  publish(artifactId: string, input: PublishArtifactRuntimeInput): Promise<PublishedArtifact>
  /** What the caller may do with the artifact; `null` when there is no such artifact. */
  access(artifactId: string): Promise<ArtifactAccess | null>
  /** `null` when the caller cannot read it. */
  get(artifactId: string): Promise<ArtifactRecord | null>
  /** Most recently updated first. */
  list(input?: ListArtifactsRuntimeInput): Promise<ListArtifactsResult>
  getVersion(artifactId: string, version: number | "latest"): Promise<ArtifactVersionRecord | null>
  /** Newest first; `null` when the caller cannot read the artifact. */
  listVersions(
    artifactId: string,
    input?: { readonly limit?: number; readonly offset?: number }
  ): Promise<ListArtifactVersionsResult | null>
  /**
   * Deletes the artifact with every version, from every conversation that shares it; only its
   * owner can. `false` when the caller does not own it.
   */
  delete(artifactId: string): Promise<boolean>
  /**
   * What the artifact keeps for the caller as its reader, as a page keeps it with `sixb.state`:
   * JSON values by key, across its versions. Each reader who may update the artifact keeps their
   * own. Each call throws `artifact_not_found`, `not_shared`, or `read_only` for an observer.
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

/** Where an access rule reads: the project's storage, or a transaction's to decide inside it. */
export type ArtifactAccessStorage = Pick<Storage, "artifacts" | "agents">

/**
 * What each runtime's caller publishes by, for this repo's packages: an Agent turn publishes with
 * the access rule and the query checker of whoever asked for it.
 */
const publishers = new WeakMap<
  object,
  {
    readonly rule: (storage?: ArtifactAccessStorage) => ArtifactAccessRule
    readonly checkQuery: ArtifactQueryChecker
  }
>()

function publisherOf(artifacts: Partial<ArtifactsRuntime>) {
  const publisher = publishers.get(artifacts)
  if (!publisher) throw new Error("[Sixb] These artifacts are not a Sixb runtime's.")
  return publisher
}

/**
 * The access rule of the caller `artifacts` acts for, reading from `storage`: a transaction's, to
 * check inside it. Each call returns a rule of its own.
 */
export function artifactAccessRule(
  artifacts: Partial<ArtifactsRuntime>,
  storage: ArtifactAccessStorage
): ArtifactAccessRule {
  return publisherOf(artifacts).rule(storage)
}

/** What checks a version's queries as the caller `artifacts` acts for. */
export function artifactQueryChecker(artifacts: Partial<ArtifactsRuntime>): ArtifactQueryChecker {
  return publisherOf(artifacts).checkQuery
}

/** The access rule for the runtime's caller, reading from `storage`. */
export function createRuntimeArtifactAccessRule(
  runtime: SixbRuntimeContext,
  storage: ArtifactAccessStorage = runtime.storage
): ArtifactAccessRule {
  const artifacts = storage.artifacts
  if (!artifacts) {
    throw new ArtifactRequestError(
      "storage_unavailable",
      "[Sixb] Artifacts need storage that supports them."
    )
  }

  const authority = resolveRuntimeAuthorizationForProject(runtime)
  const threads = createAgentThreadAccessRule(runtime, authority, storage.agents)

  return createArtifactAccessRule({
    storage: artifacts,
    projectId: runtime.projectId,
    // Shared-link sessions and unresolved authority reach no artifact.
    caller:
      authority.type === "unrestricted"
        ? "system"
        : authority.type === "principal"
          ? authority.context.principal
          : null,
    sharing: authority.type === "principal" && authority.ref.credential?.type === "session",
    conversation: async (threadId) => {
      if (await threads.read(threadId)) return "update"
      return isRuntimeAllowed(runtime, { kind: "agentThreads.observe" }) ? "read" : null
    },
  })
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

  const rule = (storage?: ArtifactAccessStorage): ArtifactAccessRule =>
    createRuntimeArtifactAccessRule(runtime, storage)
  const checkQuery = createArtifactQueryChecker(runtime)

  /** The artifact with what the caller may do with it; `null` when there is none. */
  const reach = async (
    artifactId: string
  ): Promise<{ readonly artifact: ArtifactRecord; readonly access: ArtifactAccess } | null> => {
    const artifact = await requireStorage().get({ projectId: runtime.projectId, id: artifactId })
    return artifact ? { artifact, access: await rule().accessTo(artifact) } : null
  }
  const getReadable = async (artifactId: string): Promise<ArtifactRecord | null> => {
    const reached = await reach(artifactId)
    return reached && reached.access !== "none" ? reached.artifact : null
  }

  /** What an address in a version may name: one artifact the caller reads, by one rule. */
  const readableBy = (access: ArtifactAccessRule) => async (artifact: ArtifactRecord) =>
    (await access.accessTo(artifact)) !== "none"

  /** The artifact, refused unless the caller may update it. */
  const requireUpdatable = async (artifactId: string): Promise<ArtifactRecord> => {
    const reached = await reach(artifactId)
    if (!reached) throw notFound(artifactId)
    assertUpdatable(artifactId, reached.access)
    return reached.artifact
  }

  /**
   * Stores in one transaction, which checks again what the caller may do: a participant removed
   * while the files were checked publishes nothing.
   */
  const store = (prepared: PreparedArtifactVersion) =>
    runtime.storage.transaction(async (tx) => {
      const storage = tx.artifacts
      if (!storage) throw new Error("[Sixb] Storage transactions hold no artifacts.")

      return storeArtifactVersion(
        { projectId: runtime.projectId, storage, blobStorage },
        prepared,
        (artifact) => rule(tx).publishAccess(artifact)
      )
    })

  const artifacts: ArtifactsRuntime = {
    async create(input) {
      const author = requireCaller()
      return publishArtifact(
        { projectId: runtime.projectId, storage: requireStorage(), blobStorage },
        { ...input, author, readable: readableBy(rule()), checkQuery },
        (artifact) => rule().publishAccess(artifact)
      )
    },

    async publish(artifactId, input) {
      const author = requireCaller()
      await requireUpdatable(artifactId)

      const context = { projectId: runtime.projectId, storage: requireStorage(), blobStorage }
      const prepared = await prepareArtifactVersion(context, {
        ...input,
        artifactId,
        author,
        readable: readableBy(rule()),
        checkQuery,
      })
      const stored = await store(prepared)

      return { ...stored, warnings: await artifactVersionWarnings(context, prepared, stored) }
    },

    async access(artifactId) {
      return (await reach(artifactId))?.access ?? null
    },

    get: getReadable,

    async list(input = {}) {
      if (!caller) return { artifacts: [], hasMore: false, total: 0 }

      // Whoever reads a conversation reads every artifact it shares; anyone else, their own in it.
      const everyShared =
        input.threadId !== undefined && (await rule().conversation(input.threadId)) !== null
      const ownerFilter = authority.type === "principal" && !everyShared ? caller : null

      return requireStorage().list({
        projectId: runtime.projectId,
        ...(ownerFilter ? { owner: ownerFilter } : {}),
        ...(input.threadId === undefined ? {} : { threadId: input.threadId }),
        ...(input.kind === undefined ? {} : { kind: input.kind }),
        ...(input.limit === undefined ? {} : { limit: input.limit }),
        ...(input.offset === undefined ? {} : { offset: input.offset }),
      })
    },

    async getVersion(artifactId, version) {
      const artifact = await getReadable(artifactId)
      if (!artifact) return null
      return requireStorage().getVersion({
        projectId: runtime.projectId,
        artifactId,
        version: version === "latest" ? artifact.latestVersion : version,
      })
    },

    async listVersions(artifactId, input = {}) {
      if (!(await getReadable(artifactId))) return null
      return requireStorage().listVersions({ projectId: runtime.projectId, artifactId, ...input })
    },

    async delete(artifactId) {
      if ((await reach(artifactId))?.access !== "owner") return false
      return requireStorage().delete({ projectId: runtime.projectId, id: artifactId })
    },

    state(artifactId) {
      // The reader is the caller; an observer reads the page but keeps nothing in it.
      const scope = async () => {
        const principal = requireCaller()
        await requireUpdatable(artifactId)
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

  publishers.set(artifacts, { rule, checkQuery })
  return artifacts
}

/**
 * A key a page names a value by: a short line of text. Not `.` or `..`, which a page could never
 * reach: the API takes the key in its path, where those name another route.
 */
function stateKey(key: string): string {
  if (
    typeof key !== "string" ||
    key.length === 0 ||
    key.length > ARTIFACT_STATE_LIMITS.maxKeyLength ||
    /\p{Cc}/u.test(key) ||
    key === "." ||
    key === ".."
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
