import { createAgentThreadAccessRule } from "../agents/thread-access"
import { type Principal, SYSTEM_PRINCIPAL } from "../auth"
import { isRuntimeAllowed } from "../authorization"
import type { BlobStorage } from "../blob-storage/types"
import { resolveRuntimeAuthorizationForProject } from "../execution/authorization"
import { type AuthorizedObjectReader, objectReadersIn } from "../execution/authorized-object-reader"
import type { SharedAccessDelegationRef } from "../execution/types"
import type { ObjectQuery } from "../objects/query/ir"
import type { PropertyToken } from "../ontology/tokens"
import type { SixbRuntimeContext } from "../runtime/types"
import { ArtifactStorageError } from "../storage/artifacts/errors"
import type {
  ArtifactCommentAuthor,
  ArtifactFile,
  ArtifactGuest,
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
  type HolderAccess,
} from "./access"
import { type ArtifactCommentsRuntime, createArtifactCommentsRuntime } from "./comments"
import { ArtifactRequestError } from "./errors"
import { announceArtifactUpdates } from "./events"
import { type ArtifactHolding, readableHoldings } from "./holders"
import type { ArtifactKind } from "./kinds"
import { ARTIFACT_HOLDERS_LIMIT, ARTIFACT_LIMITS, ARTIFACT_STATE_LIMITS } from "./limits"
import { firstArtifactDocument, keepsDocument } from "./live/state"
import { invalidArtifact, readArtifactText } from "./publish/files"
import { type ArtifactWrite, withDocumentHolding, withMergedWrite } from "./publish/merge"
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

export interface UpdateArtifactRuntimeInput extends ArtifactContentInput {
  /**
   * The revision this content was made from, such as the one a person edited. When the artifact
   * changed since, the update fails with `artifact_moved`, naming its revision and who wrote it;
   * a canvas instead takes what changed from that revision's files into what it holds now.
   */
  readonly baseRevision?: number
  /**
   * The files of `baseRevision`, which a canvas's merge starts from. Without them, it looks for
   * them among the artifact's versions and restore points, and refuses with `artifact_moved` when
   * none holds them.
   */
  readonly baseFiles?: readonly ArtifactFile[]
  /**
   * The title of `baseRevision`. A canvas merged past it keeps a title someone gave it since,
   * unless this write changes the title itself.
   */
  readonly baseTitle?: string
}

/**
 * A live room's write-back, for this repo's server: the canvas's Yjs document as its editors hold
 * it, merged into the stored one. The version holds what the merged document holds.
 */
export interface LiveArtifactWrite {
  readonly title: string
  /** The title the room last read: a title given since stays. */
  readonly baseTitle: string
  /** The revision the room last took in. */
  readonly baseRevision: number
  /**
   * The document's files as the room stored them: what the merged version holds alike keeps
   * these references.
   */
  readonly files: readonly ArtifactFile[]
  /** The document, encoded with `Y.encodeStateAsUpdate`. */
  readonly update: Uint8Array
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
 * The artifacts the caller reaches: its own, those shared in a conversation it reads, and those
 * held by an object it reads, as {@link ArtifactAccess} says. System code reaches every artifact in
 * the project, and an access token no conversation's.
 */
export interface ArtifactsRuntime extends ArtifactCommentsRuntime {
  /** Creates an artifact owned by the caller, with its first version. */
  create(input: ArtifactContentInput): Promise<PublishedArtifact>
  /**
   * Writes the latest version, authored by the caller: its open version's content is replaced, or
   * the next version opens when it is frozen. The artifact keeps its owner, and the kind must be
   * its. Throws `not_shared` or `read_only` when the caller may not update it.
   */
  update(artifactId: string, input: UpdateArtifactRuntimeInput): Promise<PublishedArtifact>
  /**
   * Creates a version: the open latest version is frozen, so it never changes again and the next
   * write opens the next one. A latest version already frozen is returned as it is. Who may
   * update may freeze; throws as `update` does.
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
   * `update` writes it. What it replaces becomes a restore point, so the restore can be undone.
   * Throws as `update` does, and `restore_point_not_found`.
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
  /**
   * The caller's own artifacts, or a conversation's, most recently updated first. One the caller
   * reaches only through an object is opened from that object: see `holders`.
   */
  list(input?: ListArtifactsRuntimeInput): Promise<ListArtifactsResult>
  /**
   * The objects that hold the artifact in a property, among those the caller reads with that
   * property: the first {@link ARTIFACT_HOLDERS_LIMIT}, in a stable order. `null` when the caller
   * cannot read the artifact.
   */
  holders(artifactId: string): Promise<ArtifactHolders | null>
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

/** The objects that hold an artifact, as the caller reads them. */
export interface ArtifactHolders {
  readonly holders: readonly ArtifactHolderObject[]
  /** More objects the caller reads hold it. */
  readonly hasMore: boolean
}

/** An object property that holds the artifact. */
export interface ArtifactHolderObject {
  readonly objectTypeId: string
  readonly primaryId: string
  readonly propertyId: string
  /** The object's value of its type's `search.title`, when it has one the caller reads. */
  readonly title?: string
}

export interface ArtifactStateValue {
  readonly key: string
  readonly value: unknown
  readonly updatedAt: Date
}

/** Where an access rule reads: the project's storage, or a transaction's to decide inside it. */
export type ArtifactAccessStorage = Pick<Storage, "artifacts" | "agents" | "objects">

/**
 * What each runtime's caller publishes by, for this repo's packages: an Agent turn publishes with
 * the access rule and the query checker of whoever asked for it.
 */
const publishers = new WeakMap<
  object,
  {
    readonly rule: () => ArtifactAccessRule
    readonly transactionRules: () => Promise<TransactionAccessRules>
    readonly checkQuery: ArtifactQueryChecker
    readonly requestPreviews: BoardPreviewRequester
    readonly writeLive: (artifactId: string, write: LiveArtifactWrite) => Promise<PublishedArtifact>
  }
>()

function publisherOf(artifacts: Partial<ArtifactsRuntime>) {
  const publisher = publishers.get(artifacts)
  if (!publisher) throw new Error("[Sixb] These artifacts are not a Sixb runtime's.")
  return publisher
}

/** The access rule of the caller `artifacts` acts for. Each call returns a rule of its own. */
export function artifactAccessRule(artifacts: Partial<ArtifactsRuntime>): ArtifactAccessRule {
  return publisherOf(artifacts).rule()
}

/** {@link transactionArtifactAccessRules} for the caller `artifacts` acts for. */
export function artifactTransactionRules(
  artifacts: Partial<ArtifactsRuntime>
): Promise<TransactionAccessRules> {
  return publisherOf(artifacts).transactionRules()
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

/**
 * Writes a live room's document back into the canvas, as the caller `artifacts` acts for: the
 * write `update` makes, checked, authored and announced as it is, from the document instead of
 * from files.
 */
export function writeLiveArtifact(
  artifacts: Partial<ArtifactsRuntime>,
  artifactId: string,
  write: LiveArtifactWrite
): Promise<PublishedArtifact> {
  return publisherOf(artifacts).writeLive(artifactId, write)
}

/** The access rule for the runtime's caller, reading the project's storage. */
export function createRuntimeArtifactAccessRule(runtime: SixbRuntimeContext): ArtifactAccessRule {
  return accessRuleIn(runtime, runtime.storage, runtime.objectReader)
}

/** The runtime caller's access rule for a transaction's storage, deciding inside it. */
export type TransactionAccessRules = (tx: ArtifactAccessStorage) => ArtifactAccessRule

/**
 * The access rule for the runtime's caller in a storage transaction: its threads, its holders and
 * its objects are the transaction's, so a participant removed or an object changed meanwhile is
 * seen. What the caller is cleared for is resolved now, before the transaction opens: resolving it
 * may read the project's storage, which a transaction's callback cannot.
 */
export async function transactionArtifactAccessRules(
  runtime: SixbRuntimeContext
): Promise<TransactionAccessRules> {
  const readerIn = await objectReadersIn(runtime.objectReader)
  return (tx) => accessRuleIn(runtime, tx, readerIn(tx.objects))
}

/** The rule reading `storage`, with `reader` reading its objects as the caller. */
function accessRuleIn(
  runtime: SixbRuntimeContext,
  storage: ArtifactAccessStorage,
  reader: AuthorizedObjectReader
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
    // A shared link's session reaches artifacts as a guest; unresolved authority reaches none.
    caller:
      authority.type === "unrestricted"
        ? "system"
        : authority.type === "principal"
          ? authority.context.principal
          : authority.type === "delegated"
            ? "guest"
            : null,
    sharing: authority.type === "principal" && authority.ref.credential?.type === "session",
    conversation: async (threadId) => {
      if (await threads.read(threadId)) return "update"
      return isRuntimeAllowed(runtime, { kind: "agentThreads.observe" }) ? "read" : null
    },
    holders: async (artifact) => {
      let access: HolderAccess = null
      const holdings = readableHoldings({
        runtime,
        reader,
        objects: storage.objects,
        artifactId: artifact.id,
      })

      for await (const holding of holdings) {
        if (holding.access === "update") return "update"
        access = "read"
      }
      return access
    },
  })
}

/**
 * The artifacts among `artifactIds` that the runtime's caller may change, as its owner or with
 * `update`, as its access rule decides now. One that does not exist is not among them, and
 * without artifact storage none is.
 */
export async function updatableArtifactIds(
  runtime: SixbRuntimeContext,
  artifactIds: Iterable<string>
): Promise<ReadonlySet<string>> {
  const ids = [...new Set(artifactIds)]
  const storage = runtime.storage.artifacts
  if (ids.length === 0 || !storage) return new Set()

  const rule = createRuntimeArtifactAccessRule(runtime)
  const updatable = await Promise.all(
    ids.map(async (id) => {
      const artifact = await storage.get({ projectId: runtime.projectId, id })
      if (!artifact) return []

      const access = await rule.accessTo(artifact)
      return access === "owner" || access === "update" ? [id] : []
    })
  )

  return new Set(updatable.flat())
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
  // A shared link's session writes nothing but comments, as a guest; unresolved authority, nothing.
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
      throw new ArtifactRequestError(
        "not_allowed",
        authority.type === "delegated"
          ? "[Sixb] A shared link's guest reads its artifacts and comments on them, nothing more."
          : "[Sixb] This caller cannot publish artifacts."
      )
    }
    return caller
  }

  /** Who writes a comment: the caller, or a shared link's guest under the name they gave. */
  const commentAuthor = async (): Promise<ArtifactCommentAuthor> => {
    if (authority.type !== "delegated" || !authority.delegation) return requireCaller()
    return sharedLinkGuest(runtime, authority.delegation)
  }

  const rule = (): ArtifactAccessRule => createRuntimeArtifactAccessRule(runtime)
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
   * Stores in one transaction, which checks again what the caller may do: a participant removed,
   * or an object that no longer holds the artifact, while the files were checked publishes nothing.
   */
  const store = async (prepared: PreparedArtifactVersion) => {
    const ruleIn = await transactionArtifactAccessRules(runtime)

    return runtime.storage.transaction(async (tx) => {
      const storage = tx.artifacts
      if (!storage) throw new Error("[Sixb] Storage transactions hold no artifacts.")

      return storeArtifactVersion(
        { projectId: runtime.projectId, storage, blobStorage },
        prepared,
        (artifact) => ruleIn(tx).publishAccess(artifact)
      )
    })
  }

  /**
   * Changes an artifact the caller may update, in one transaction that decides it there, so a
   * participant removed, or an object changed, meanwhile changes nothing.
   */
  const change = async (
    artifactId: string,
    write: (storage: ArtifactStorage, author: Principal) => Promise<PublishedArtifactVersion>
  ) => {
    const author = requireCaller()
    requireStorage()
    const ruleIn = await transactionArtifactAccessRules(runtime)

    return runtime.storage.transaction(async (tx) => {
      const storage = tx.artifacts
      if (!storage) throw new Error("[Sixb] Storage transactions hold no artifacts.")

      const artifact = await storage.get({ projectId: runtime.projectId, id: artifactId })
      if (!artifact) throw notFound(artifactId)
      assertUpdatable(artifactId, await ruleIn(tx).publishAccess(artifact))

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

  /**
   * Stores the latest version, authored by the caller, who may update the artifact. A canvas
   * written since the base is merged into, not refused: the merge is what is checked.
   */
  const write = async (
    input: ArtifactWrite & { readonly title: string }
  ): Promise<PublishedArtifact> => {
    const author = requireCaller()
    const context = { projectId: runtime.projectId, storage: requireStorage(), blobStorage }

    return withMergedWrite(context, input, async (merged) => {
      const prepared = await prepareArtifactVersion(context, {
        artifactId: input.artifactId,
        kind: input.kind,
        title: merged.title ?? input.title,
        files: merged.files,
        ...(merged.baseRevision === undefined ? {} : { baseRevision: merged.baseRevision }),
        ...(merged.document ? { document: merged.document } : {}),
        author,
        readable: readableBy(rule()),
        checkQuery,
      })
      const stored = await store(prepared)
      await announceArtifactUpdates(runtime.events, [stored.version])
      await requestPreviews(stored.version)

      return {
        ...stored,
        warnings: await artifactVersionWarnings(context, prepared, stored),
        ...(merged.merged ? { merged: true as const } : {}),
      }
    })
  }

  /** A live room's write-back: only a canvas keeps a document to merge it into. */
  const writeLive = async (
    artifactId: string,
    input: LiveArtifactWrite
  ): Promise<PublishedArtifact> => {
    const artifact = await requireUpdatable(artifactId)
    if (!keepsDocument(artifact.kind)) {
      throw invalidArtifact(
        `Artifact '${artifactId}' is a ${artifact.kind}, which is not edited live: publish its files.`
      )
    }

    return write({ artifactId, kind: artifact.kind, ...input })
  }

  const artifacts: ArtifactsRuntime = {
    ...createArtifactCommentsRuntime({
      projectId: runtime.projectId,
      storage: requireStorage,
      events: runtime.events,
      author: commentAuthor,
      manager: requireCaller,
      reach,
    }),

    async create(input) {
      const author = requireCaller()
      const files = await contentFiles(input)
      const document = await firstArtifactDocument(blobStorage, input.kind, files)

      const published = await publishArtifact(
        { projectId: runtime.projectId, storage: requireStorage(), blobStorage },
        {
          kind: input.kind,
          title: input.title,
          files,
          ...(document ? { document } : {}),
          author,
          readable: readableBy(rule()),
          checkQuery,
        },
        (artifact) => rule().publishAccess(artifact)
      )
      await requestPreviews(published.version)

      return published
    },

    async update(artifactId, input) {
      await requireUpdatable(artifactId)

      return write({
        artifactId,
        kind: input.kind,
        files: await contentFiles(input),
        ...(input.baseRevision === undefined ? {} : { baseRevision: input.baseRevision }),
        ...(input.baseFiles === undefined ? {} : { baseFiles: input.baseFiles }),
        title: input.title,
        ...(input.baseTitle === undefined ? {} : { baseTitle: input.baseTitle }),
      })
    },

    async freeze(artifactId, input = {}) {
      const frozenAt = new Date()
      const frozen = await change(artifactId, (storage, author) =>
        storage.freeze({
          projectId: runtime.projectId,
          artifactId,
          ...(input.baseRevision === undefined ? {} : { baseRevision: input.baseRevision }),
          frozenAt,
          frozenBy: author,
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
      // A canvas's document takes the restored content as a change, so editors keep theirs.
      const context = { projectId: runtime.projectId, storage: requireStorage(), blobStorage }
      const point = await context.storage.getRestorePoint({
        projectId: runtime.projectId,
        artifactId,
        revision,
      })
      const restored = await withDocumentHolding(
        context,
        artifactId,
        point?.files ?? null,
        input.baseRevision,
        (held) =>
          change(artifactId, (storage, author) =>
            storage.restoreTo({
              projectId: runtime.projectId,
              artifactId,
              revision,
              ...held,
              author,
              restoredAt: new Date(),
            })
          )
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

    async holders(artifactId) {
      if (!(await getReadable(artifactId))) return null

      const holders: ArtifactHolderObject[] = []
      const holdings = readableHoldings({
        runtime,
        reader: runtime.objectReader,
        objects: runtime.storage.objects,
        artifactId,
      })

      // One past the page says whether there are more.
      for await (const holding of holdings) {
        if (holders.length === ARTIFACT_HOLDERS_LIMIT) return { holders, hasMore: true }
        holders.push(holderObject(runtime, holding))
      }
      return { holders, hasMore: false }
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

  publishers.set(artifacts, {
    rule,
    transactionRules: () => transactionArtifactAccessRules(runtime),
    checkQuery,
    requestPreviews,
    writeLive,
  })
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

/** A holding as `holders` returns it: where it is, with the object's title when it has one. */
function holderObject(runtime: SixbRuntimeContext, holding: ArtifactHolding): ArtifactHolderObject {
  const { objectTypeId, primaryId, propertyId, object } = holding
  const titleId = runtime.ontology.getObjectTypeById(objectTypeId)?.search?.title
  const value = titleId === undefined ? undefined : object.properties[titleId]
  const title = typeof value === "string" || typeof value === "number" ? String(value).trim() : ""

  return { objectTypeId, primaryId, propertyId, ...(title ? { title } : {}) }
}

/**
 * The guest a shared link's session comments as: the name its visitor gave, kept by the session.
 * Refused with `name_required` until they give one.
 */
async function sharedLinkGuest(
  runtime: SixbRuntimeContext,
  delegation: SharedAccessDelegationRef
): Promise<ArtifactGuest> {
  const session = await runtime.storage.shareSessions?.getById({
    projectId: runtime.projectId,
    id: delegation.sessionId,
  })

  const name = session?.grantId === delegation.grantId ? session.guestName : undefined
  if (!name) {
    throw new ArtifactRequestError(
      "name_required",
      "[Sixb] A shared link's guest gives their name before they comment."
    )
  }

  return { type: "guest", id: delegation.sessionId, name, grantId: delegation.grantId }
}

function notFound(artifactId: string): ArtifactRequestError {
  return new ArtifactRequestError(
    "artifact_not_found",
    `[Sixb] Artifact '${artifactId}' was not found.`
  )
}
