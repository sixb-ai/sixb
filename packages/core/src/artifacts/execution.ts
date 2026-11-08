import { createAgentThreadAccessRule } from "../agents/thread-access"
import { type Principal, SYSTEM_PRINCIPAL } from "../auth"
import { isRuntimeAllowed } from "../authorization"
import type { BlobStorage } from "../blob-storage/types"
import { resolveRuntimeAuthorizationForProject } from "../execution/authorization"
import type { ObjectQuery } from "../objects/query/ir"
import type { PropertyToken } from "../ontology/tokens"
import type { SixbRuntimeContext } from "../runtime/types"
import { ArtifactStorageError } from "../storage/artifacts/errors"
import type {
  ArtifactFile,
  ArtifactRecord,
  ArtifactRestorePointRecord,
  ArtifactStorage,
  ArtifactVersionRecord,
  ListArtifactsResult,
  ListArtifactVersionsResult,
  PublishedArtifactVersion,
} from "../storage/artifacts/types"
import type { Storage } from "../storage/types"
import {
  type ArtifactAccess,
  type ArtifactAccessRule,
  assertUpdatable,
  createArtifactAccessRule,
} from "./access"
import { ArtifactRequestError } from "./errors"
import { announceArtifactUpdates } from "./events"
import type { ArtifactKind } from "./kinds"
import { ARTIFACT_LIMITS, ARTIFACT_STATE_LIMITS } from "./limits"
import { invalidArtifact, readArtifactText } from "./publish/files"
import {
  type BoardPreviewRequester,
  boardsReadLiveData,
  requestBoardPreviews,
} from "./publish/previews"
import {
  artifactRequestError,
  artifactVersionWarnings,
  type PreparedArtifactVersion,
  type PublishedArtifact,
  prepareArtifactVersion,
  publishArtifact,
  storeArtifactVersion,
} from "./publish/publish"
import { type ArtifactQueryChecker, createArtifactQueryChecker } from "./publish/queries"
import {
  ARTIFACT_QUERY_KINDS,
  type ArtifactQueryResult,
  artifactQueryPath,
  isArtifactQueryName,
  parseArtifactQuery,
} from "./queries"
import { runArtifactQuery } from "./run-query"

/** A version's content: what its kind renders from, and what it is called. */
export interface ArtifactContentInput {
  readonly kind: ArtifactKind
  readonly title: string
  /** Files stored with `sixb.blobs.put()` or `POST /api/files`, at their paths in the artifact. */
  readonly files: readonly ArtifactFile[]
  /**
   * Queries the version holds, by name, each stored as `queries/<name>.json` beside `files` and
   * checked as those files are. Each reader runs them with their own rights.
   */
  readonly queries?: Readonly<Record<string, ArtifactQueryInput>>
}

/**
 * A query a version holds, from the query builders: `sixb.objects(Invoice).where(...)` for rows,
 * or such a query with the properties to facet its rows by. Any builder fits: its `ir` is what
 * the version keeps.
 */
export type ArtifactQueryInput =
  | { readonly ir: ObjectQuery }
  | {
      readonly query: { readonly ir: ObjectQuery }
      readonly facets: readonly { readonly property: PropertyToken; readonly limit: number }[]
    }

export interface PublishArtifactRuntimeInput extends ArtifactContentInput {
  /**
   * The revision this content was made from, such as the one a person edited. When the artifact
   * changed since, publishing fails with `artifact_moved`, naming its revision and who wrote it.
   */
  readonly baseRevision?: number
}

/** A change made from what the caller saw: past `baseRevision`, it fails with `artifact_moved`. */
export interface ArtifactRevisionInput {
  readonly baseRevision?: number
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
   * Writes the latest version, authored by the caller: its open version's content is replaced, or
   * the next version opens when it is frozen. The artifact keeps its owner, and the kind must be
   * its. Throws `not_shared` or `read_only` when the caller may not update it.
   */
  publish(artifactId: string, input: PublishArtifactRuntimeInput): Promise<PublishedArtifact>
  /**
   * Creates a version: the open latest version is frozen, so it never changes again and the next
   * write opens the next one. A latest version already frozen is returned as it is. Who may
   * publish may freeze; throws as `publish` does.
   */
  freeze(artifactId: string, input?: ArtifactRevisionInput): Promise<PublishedArtifactVersion>
  /**
   * What the artifact's latest version held before each Agent turn's first write to it, and
   * before each restore, newest first; `null` when the caller cannot read the artifact.
   */
  listRestorePoints(artifactId: string): Promise<ArtifactRestorePointRecord[] | null>
  /** `null` when the caller cannot read the artifact, or it keeps no such restore point. */
  getRestorePoint(artifactId: string, revision: number): Promise<ArtifactRestorePointRecord | null>
  /**
   * Puts a restore point's content back in the latest version, authored by the caller, as
   * `publish` writes it. What it replaces becomes a restore point, so the restore can be undone.
   * Throws as `publish` does, and `restore_point_not_found`.
   */
  restore(
    artifactId: string,
    revision: number,
    input?: ArtifactRevisionInput
  ): Promise<PublishedArtifactVersion>
  /** What the caller may do with the artifact; `null` when there is no such artifact. */
  access(artifactId: string): Promise<ArtifactAccess | null>
  /** `null` when the caller cannot read it. */
  get(artifactId: string): Promise<ArtifactRecord | null>
  /** Most recently updated first. */
  list(input?: ListArtifactsRuntimeInput): Promise<ListArtifactsResult>
  getVersion(artifactId: string, version: number | "latest"): Promise<ArtifactVersionRecord | null>
  /**
   * Runs the version's query `queries/<name>.json` as the caller, with their rights: a type they
   * cannot view refuses it, and a marked property they are not cleared for is left out of each
   * row. Whoever reads the artifact runs its queries, an observer too. `null` when the caller
   * cannot read the artifact or it has no such version. Throws `query_not_found`, and
   * `query_invalid` for a query the ontology no longer admits.
   */
  query(
    artifactId: string,
    name: string,
    options?: { readonly version?: number | "latest" }
  ): Promise<ArtifactQueryResult | null>
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
    readonly requestPreviews: BoardPreviewRequester
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

/**
 * What asks for the pictures a stored version's boards miss, in the project `artifacts` belongs
 * to: nothing in a project without sandboxes, where nothing renders them.
 */
export function artifactPreviewRequester(
  artifacts: Partial<ArtifactsRuntime>
): BoardPreviewRequester {
  return publisherOf(artifacts).requestPreviews
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
  blobStorage: BlobStorage,
  options: {
    /** The project has sandboxes, where the agent worker renders the pictures of boards. */
    readonly rendersBoardPreviews?: boolean
  } = {}
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
  const requestPreviews: BoardPreviewRequester = async (version, requestOptions) => {
    const storage = runtime.storage.artifacts
    if (!options.rendersBoardPreviews || !storage) return

    // Its queries are answered as whoever published it, who is this runtime's caller.
    await requestBoardPreviews(
      {
        storage,
        queue: runtime.queues.agents,
        blobStorage,
        query: (name) => artifacts.query(version.artifactId, name, { version: version.version }),
      },
      version,
      requestOptions
    )
  }

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

  /** The version with its artifact; `null` when the caller cannot read it or there is none. */
  const readVersion = async (artifactId: string, number: number | "latest") => {
    const artifact = await getReadable(artifactId)
    if (!artifact) return null

    const version = await requireStorage().getVersion({
      projectId: runtime.projectId,
      artifactId,
      version: number === "latest" ? artifact.latestVersion : number,
    })
    return version ? { artifact, version } : null
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

  /**
   * Changes an artifact the caller may update, in one transaction that decides it there, so a
   * participant removed meanwhile changes nothing.
   */
  const change = (
    artifactId: string,
    write: (storage: ArtifactStorage, author: Principal) => Promise<PublishedArtifactVersion>
  ) => {
    const author = requireCaller()
    requireStorage()

    return runtime.storage.transaction(async (tx) => {
      const storage = tx.artifacts
      if (!storage) throw new Error("[Sixb] Storage transactions hold no artifacts.")

      const artifact = await storage.get({ projectId: runtime.projectId, id: artifactId })
      if (!artifact) throw notFound(artifactId)
      assertUpdatable(artifactId, await rule(tx).publishAccess(artifact))

      try {
        return await write(storage, author)
      } catch (error) {
        throw artifactRequestError(error)
      }
    })
  }

  /**
   * The version's files with its `queries` stored among them. Publishing then checks each one as
   * it checks a query file.
   */
  const contentFiles = async (input: ArtifactContentInput): Promise<readonly ArtifactFile[]> => {
    if (!input.queries) return input.files

    const files = [...input.files]
    for (const [name, query] of Object.entries(input.queries)) {
      const path = artifactQueryPath(name)
      if (input.files.some((file) => file.path === path)) {
        throw invalidArtifact(`'${path}' is both a file and a query; give it once.`)
      }

      const body = new TextEncoder().encode(JSON.stringify(queryFile(query)))
      const file = await blobStorage.put({
        body,
        expectedSizeBytes: body.byteLength,
        fileName: `${name}.json`,
        mediaType: "application/json",
      })
      files.push({ path, file })
    }
    return files
  }

  const artifacts: ArtifactsRuntime = {
    async create(input) {
      const author = requireCaller()

      const published = await publishArtifact(
        { projectId: runtime.projectId, storage: requireStorage(), blobStorage },
        {
          kind: input.kind,
          title: input.title,
          files: await contentFiles(input),
          author,
          readable: readableBy(rule()),
          checkQuery,
        },
        (artifact) => rule().publishAccess(artifact)
      )
      await requestPreviews(published.version)

      return published
    },

    async publish(artifactId, input) {
      const author = requireCaller()
      await requireUpdatable(artifactId)

      const context = { projectId: runtime.projectId, storage: requireStorage(), blobStorage }
      const prepared = await prepareArtifactVersion(context, {
        artifactId,
        kind: input.kind,
        title: input.title,
        files: await contentFiles(input),
        ...(input.baseRevision === undefined ? {} : { baseRevision: input.baseRevision }),
        author,
        readable: readableBy(rule()),
        checkQuery,
      })
      const stored = await store(prepared)
      await announceArtifactUpdates(runtime.events, [stored.version])
      await requestPreviews(stored.version)

      return { ...stored, warnings: await artifactVersionWarnings(context, prepared, stored) }
    },

    async freeze(artifactId, input = {}) {
      const frozenAt = new Date()
      const frozen = await change(artifactId, (storage) =>
        storage.freeze({
          projectId: runtime.projectId,
          artifactId,
          ...(input.baseRevision === undefined ? {} : { baseRevision: input.baseRevision }),
          frozenAt,
        })
      )

      // A version frozen before changed nothing to announce.
      if (frozen.version.frozenAt?.getTime() === frozenAt.getTime()) {
        await announceArtifactUpdates(runtime.events, [frozen.version])
      }
      return frozen
    },

    async listRestorePoints(artifactId) {
      if (!(await getReadable(artifactId))) return null
      return requireStorage().listRestorePoints({ projectId: runtime.projectId, id: artifactId })
    },

    async getRestorePoint(artifactId, revision) {
      if (!(await getReadable(artifactId))) return null
      return requireStorage().getRestorePoint({
        projectId: runtime.projectId,
        artifactId,
        revision,
      })
    },

    async restore(artifactId, revision, input = {}) {
      const restored = await change(artifactId, (storage, author) =>
        storage.restoreTo({
          projectId: runtime.projectId,
          artifactId,
          revision,
          ...(input.baseRevision === undefined ? {} : { baseRevision: input.baseRevision }),
          author,
          restoredAt: new Date(),
        })
      )
      await announceArtifactUpdates(runtime.events, [restored.version])

      // Pictures of live boards show their author's data: a restore by someone else leaves the
      // ones it misses to the boards that read none.
      await requestPreviews(
        restored.version,
        boardsReadLiveData(restored.version) ? { withoutAnswers: true } : {}
      )
      return restored
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
      return (await readVersion(artifactId, version))?.version ?? null
    },

    async query(artifactId, name, options = {}) {
      const read = await readVersion(artifactId, options.version ?? "latest")
      if (!read) return null

      // A file artifact is delivered as it is: its one file is never run.
      const { artifact, version } = read
      const file =
        ARTIFACT_QUERY_KINDS.includes(artifact.kind) && isArtifactQueryName(name)
          ? version.files.find((candidate) => candidate.path === artifactQueryPath(name))
          : undefined
      if (!file) {
        throw new ArtifactRequestError(
          "query_not_found",
          `[Sixb] Version ${version.version} of artifact '${artifactId}' has no query '${name}'.`
        )
      }

      const text = await readArtifactText(blobStorage, file, ARTIFACT_LIMITS.maxQueryBytes)
      const parsed = parseArtifactQuery(file.path, text)
      if ("error" in parsed) {
        throw new ArtifactRequestError("query_invalid", `[Sixb] ${parsed.error}`)
      }

      return runArtifactQuery(runtime, name, parsed.query)
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

  publishers.set(artifacts, { rule, checkQuery, requestPreviews })
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

/** What a query file holds for a query from the builders: its IR, with any facets by id. */
function queryFile(query: ArtifactQueryInput): unknown {
  if ("ir" in query) return query.ir

  return {
    query: query.query.ir,
    facets: query.facets.map((facet) => ({ propertyId: facet.property.id, limit: facet.limit })),
  }
}

function notFound(artifactId: string): ArtifactRequestError {
  return new ArtifactRequestError(
    "artifact_not_found",
    `[Sixb] Artifact '${artifactId}' was not found.`
  )
}
