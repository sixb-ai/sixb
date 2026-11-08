import { ARTIFACT_COMMENT_LIMITS, ARTIFACT_RESTORE_POINTS } from "../../artifacts/limits"
import { type Principal, principalsEqual } from "../../auth"
import type { FileRef } from "../../blob-storage"
import { paginate } from "../pagination"
import {
  artifactStateBytes,
  artifactStorageErrors,
  checkArtifactStateWrite,
  turnUndoable,
} from "./record"
import type {
  ArtifactBoardPreviewRecord,
  ArtifactCommentKey,
  ArtifactCommentRecord,
  ArtifactFrameGrantRecord,
  ArtifactRecord,
  ArtifactRestorePointReason,
  ArtifactRestorePointRecord,
  ArtifactStateEntry,
  ArtifactStateKeyInput,
  ArtifactStateScope,
  ArtifactStorage,
  ArtifactTurnInput,
  ArtifactTurnWriteRecord,
  ArtifactVersionInput,
  ArtifactVersionRecord,
  CopyArtifactInput,
  CreateArtifactCommentInput,
  CreateArtifactInput,
  DeleteArtifactInput,
  DeleteExpiredArtifactFrameGrantsInput,
  FindArtifactFrameGrantInput,
  FreezeArtifactVersionInput,
  GetArtifactInput,
  GetArtifactRestorePointInput,
  GetArtifactVersionInput,
  ListArtifactBoardPreviewsInput,
  ListArtifactsInput,
  ListArtifactsResult,
  ListArtifactVersionsInput,
  ListArtifactVersionsResult,
  ListReferencingVersionsInput,
  PublishArtifactVersionInput,
  PublishedArtifactVersion,
  PutArtifactBoardPreviewsInput,
  ResolveArtifactCommentInput,
  RestoreArtifactInput,
  SetArtifactStateInput,
  UndoArtifactTurnInput,
  UndoneArtifactTurn,
} from "./types"

interface StoredArtifact {
  readonly record: ArtifactRecord
  /** Oldest first: only the last may be open. */
  readonly versions: readonly ArtifactVersionRecord[]
  /** The number the next version gets; it only grows, so a deleted number is never reused. */
  readonly nextVersion: number
  /** The threads it is shared in, by id. */
  readonly threads: ReadonlyMap<string, ThreadLink>
  /** Newest first. */
  readonly restorePoints: readonly ArtifactRestorePointRecord[]
  /** What each Agent turn that wrote it last left it at, by the turn's run. */
  readonly turnWrites: ReadonlyMap<string, ArtifactTurnWriteRecord>
  /** Oldest first. */
  readonly comments: readonly ArtifactCommentRecord[]
}

interface ThreadLink {
  /** When it was first shared there. */
  readonly sharedAt: Date
  /** Copied for the thread: shared there for as long as it lasts. */
  readonly copied: boolean
  /** The Agent turn whose write shared it there, which a retry of the turn takes back. */
  readonly linkedByRunId?: string
}

interface InMemoryArtifactSnapshot {
  readonly artifacts: ReadonlyMap<string, StoredArtifact>
  readonly frameGrants: ReadonlyMap<string, ArtifactFrameGrantRecord>
  readonly state: ReadonlyMap<string, ReadonlyMap<string, ArtifactStateEntry>>
  readonly boardPreviews: ReadonlyMap<string, ArtifactBoardPreviewRecord>
}

export class InMemoryArtifactStorage implements ArtifactStorage {
  private artifacts = new Map<string, StoredArtifact>()
  private frameGrants = new Map<string, ArtifactFrameGrantRecord>()
  /** By artifact and reader, then by key. */
  private state = new Map<string, Map<string, ArtifactStateEntry>>()
  /** By project, render key, mode, and size; no artifact owns one. */
  private boardPreviews = new Map<string, ArtifactBoardPreviewRecord>()

  async create(input: CreateArtifactInput): Promise<PublishedArtifactVersion> {
    const key = artifactKey(input.projectId, input.id)
    if (this.artifacts.has(key)) throw artifactStorageErrors.exists(input.id)

    const content = input.version
    const version = versionRecord(input.projectId, input.id, {
      version: 1,
      revision: 1,
      content,
      createdAt: content.updatedAt,
    })
    const record: ArtifactRecord = {
      projectId: input.projectId,
      id: input.id,
      kind: input.kind,
      title: version.title,
      owner: { ...input.owner },
      latestVersion: 1,
      revision: 1,
      createdAt: new Date(content.updatedAt),
      updatedAt: new Date(content.updatedAt),
      ...(input.document
        ? { document: { file: structuredClone(input.document), revision: 1 } }
        : {}),
    }

    const stored = turnWrote(
      sharedIn(
        {
          record,
          versions: [version],
          nextVersion: 2,
          threads: new Map(),
          restorePoints: [],
          turnWrites: new Map(),
          comments: [],
        },
        content,
        input.turnRunId
      ),
      input.turnRunId,
      { created: true }
    )
    this.artifacts.set(key, stored)
    return published(stored)
  }

  async publish(input: PublishArtifactVersionInput): Promise<PublishedArtifactVersion> {
    const key = artifactKey(input.projectId, input.artifactId)
    const stored = this.artifacts.get(key)
    if (!stored) throw artifactStorageErrors.notFound(input.artifactId)
    if (stored.record.kind !== input.kind) {
      throw artifactStorageErrors.kindMismatch(input.artifactId, stored.record.kind, input.kind)
    }
    assertBase(stored, input.baseRevision)

    // A turn's first write keeps what it replaces, so the turn can be undone.
    const { turnRunId } = input
    const firstOfTurn = turnRunId !== undefined && !stored.turnWrites.has(turnRunId)
    const kept = firstOfTurn
      ? withRestorePoint(stored, {
          reason: "turn",
          turnRunId,
          createdAt: input.version.updatedAt,
        })
      : stored

    const next = turnWrote(
      sharedIn(written(kept, input.version, input.document), input.version, turnRunId),
      turnRunId,
      { created: false }
    )
    this.artifacts.set(key, next)
    return published(next)
  }

  async freeze(input: FreezeArtifactVersionInput): Promise<PublishedArtifactVersion> {
    const key = artifactKey(input.projectId, input.artifactId)
    const stored = this.artifacts.get(key)
    if (!stored) throw artifactStorageErrors.notFound(input.artifactId)

    const latest = latestOf(stored)
    if (latest.frozenAt) return published(stored)
    assertBase(stored, input.baseRevision)

    const revision = stored.record.revision + 1
    const frozen = {
      ...latest,
      revision,
      frozenAt: new Date(input.frozenAt),
      frozenBy: structuredClone(input.frozenBy),
    }
    // A freeze keeps the content, so a document that held it still does.
    const { document } = stored.record
    const next: StoredArtifact = {
      ...stored,
      record: {
        ...stored.record,
        revision,
        updatedAt: new Date(input.frozenAt),
        ...(document?.revision === stored.record.revision
          ? { document: { ...document, revision } }
          : {}),
      },
      versions: [...stored.versions.slice(0, -1), frozen],
    }
    this.artifacts.set(key, next)
    return published(next)
  }

  async listRestorePoints(input: GetArtifactInput): Promise<ArtifactRestorePointRecord[]> {
    const stored = this.artifacts.get(artifactKey(input.projectId, input.id))
    return structuredClone([...(stored?.restorePoints ?? [])])
  }

  async getRestorePoint(
    input: GetArtifactRestorePointInput
  ): Promise<ArtifactRestorePointRecord | null> {
    const stored = this.artifacts.get(artifactKey(input.projectId, input.artifactId))
    const point = stored?.restorePoints.find((each) => each.revision === input.revision)
    return point ? structuredClone(point) : null
  }

  async restoreTo(input: RestoreArtifactInput): Promise<PublishedArtifactVersion> {
    const key = artifactKey(input.projectId, input.artifactId)
    const stored = this.artifacts.get(key)
    if (!stored) throw artifactStorageErrors.notFound(input.artifactId)

    const point = stored.restorePoints.find((each) => each.revision === input.revision)
    if (!point) throw artifactStorageErrors.restorePointNotFound(input.artifactId, input.revision)
    assertBase(stored, input.baseRevision)

    // What the restore replaces is kept first, so the restore can be undone.
    const kept = withRestorePoint(stored, { reason: "restore", createdAt: input.restoredAt })
    const next = written(
      kept,
      {
        title: point.title,
        entry: point.entry,
        files: point.files,
        outline: point.outline,
        references: point.references,
        author: input.author,
        updatedAt: input.restoredAt,
      },
      input.document
    )
    this.artifacts.set(key, next)
    return published(next)
  }

  async listTurnWrites(input: ArtifactTurnInput): Promise<ArtifactTurnWriteRecord[]> {
    const writes: ArtifactTurnWriteRecord[] = []
    for (const stored of this.artifacts.values()) {
      if (stored.record.projectId !== input.projectId) continue

      const write = stored.turnWrites.get(input.turnRunId)
      if (write) writes.push(structuredClone(write))
    }

    // Code-unit order, as SQLite compares text.
    return writes.sort((left, right) => (left.artifactId < right.artifactId ? -1 : 1))
  }

  async undoTurnWrites(input: UndoArtifactTurnInput): Promise<UndoneArtifactTurn> {
    const { turnRunId } = input
    const restored: PublishedArtifactVersion[] = []
    const deleted: string[] = []

    for (const [key, stored] of this.artifacts) {
      if (stored.record.projectId !== input.projectId) continue

      const write = stored.turnWrites.get(turnRunId)
      if (!write) continue

      const revision = stored.record.revision
      if (write.created && turnUndoable({ write, revision })) {
        this.deleteArtifact(key)
        deleted.push(stored.record.id)
        continue
      }

      const point = stored.restorePoints.find((each) => each.turnRunId === turnRunId)
      const target = point && stored.versions.find((each) => each.version === point.version)
      const untouched =
        !write.created &&
        turnUndoable({
          write,
          revision,
          ...(point ? { point } : {}),
          ...(target ? { target: { frozen: target.frozenAt !== undefined } } : {}),
        })
      const undone =
        untouched && point ? undo(stored, point, input.documents?.[stored.record.id]) : null

      // Undone, the turn's restore point is what the artifact holds again, and the threads it
      // alone shared the artifact in no longer do. Kept, the artifact stays where it was made.
      const next = forgetTurn(undone ?? stored, turnRunId, { undone: undone !== null })
      this.artifacts.set(key, next)
      if (undone) restored.push(published(next))
    }

    return { restored, deleted }
  }

  async get(input: GetArtifactInput): Promise<ArtifactRecord | null> {
    const stored = this.artifacts.get(artifactKey(input.projectId, input.id))
    return stored ? structuredClone(stored.record) : null
  }

  async list(input: ListArtifactsInput): Promise<ListArtifactsResult> {
    const matching = [...this.artifacts.values()]
      .filter(
        ({ record, threads }) =>
          record.projectId === input.projectId &&
          (!input.owner || principalsEqual(record.owner, input.owner)) &&
          (input.kind === undefined || record.kind === input.kind) &&
          (input.threadId === undefined || threads.has(input.threadId))
      )
      .map(({ record }) => record)
      .sort(
        (left, right) =>
          right.updatedAt.getTime() - left.updatedAt.getTime() || left.id.localeCompare(right.id)
      )
    const { page, hasMore, total } = paginate(matching, input)
    return { artifacts: structuredClone(page), hasMore, total }
  }

  async getVersion(input: GetArtifactVersionInput): Promise<ArtifactVersionRecord | null> {
    const stored = this.artifacts.get(artifactKey(input.projectId, input.artifactId))
    const version = stored?.versions.find((candidate) => candidate.version === input.version)
    return version ? structuredClone(version) : null
  }

  async listVersions(input: ListArtifactVersionsInput): Promise<ListArtifactVersionsResult> {
    const stored = this.artifacts.get(artifactKey(input.projectId, input.artifactId))
    const newestFirst = [...(stored?.versions ?? [])].reverse()
    const { page, hasMore, total } = paginate(newestFirst, input)
    return { versions: structuredClone(page), hasMore, total }
  }

  async listThreadIds(input: GetArtifactInput): Promise<string[]> {
    const stored = this.artifacts.get(artifactKey(input.projectId, input.id))
    // Code-unit order, as SQLite compares text.
    return [...(stored?.threads.keys() ?? [])].sort((left, right) => (left < right ? -1 : 1))
  }

  async copy(input: CopyArtifactInput): Promise<ArtifactRecord> {
    const source = this.artifacts.get(artifactKey(input.projectId, input.sourceId))
    if (!source) throw artifactStorageErrors.notFound(input.sourceId)

    const key = artifactKey(input.projectId, input.id)
    if (this.artifacts.has(key)) throw artifactStorageErrors.exists(input.id)

    const record: ArtifactRecord = { ...source.record, id: input.id, owner: { ...input.owner } }
    const versions = source.versions.map(({ origin: _origin, ...version }) => {
      const copied = structuredClone({ ...version, artifactId: input.id })
      const outline = input.outlineOf?.(copied)
      return outline ? { ...copied, outline: structuredClone(outline) } : copied
    })
    const sharedAt = new Date(input.copiedAt ?? new Date())
    this.artifacts.set(key, {
      record,
      versions,
      nextVersion: source.nextVersion,
      threads: new Map([[input.threadId, { sharedAt, copied: true }]]),
      restorePoints: [],
      turnWrites: new Map(),
      // Comments stay with the original.
      comments: [],
    })
    return structuredClone(record)
  }

  async listReferencingVersions(
    input: ListReferencingVersionsInput
  ): Promise<ArtifactVersionRecord[]> {
    const prefix = `artifact:${input.artifactId}`
    const referencing: ArtifactVersionRecord[] = []
    for (const stored of this.artifacts.values()) {
      if (stored.record.projectId !== input.projectId) continue
      const latest = latestOf(stored)
      if (latest.references.some((reference) => refersTo(reference.address, prefix))) {
        referencing.push(structuredClone(latest))
      }
    }
    // Code-unit order, as SQLite compares text.
    return referencing.sort((left, right) => (left.artifactId < right.artifactId ? -1 : 1))
  }

  async createFrameGrant(record: ArtifactFrameGrantRecord): Promise<void> {
    if (!this.artifacts.has(artifactKey(record.projectId, record.artifactId))) {
      throw artifactStorageErrors.notFound(record.artifactId)
    }
    this.frameGrants.set(artifactKey(record.projectId, record.tokenHash), structuredClone(record))
  }

  async findFrameGrant(
    input: FindArtifactFrameGrantInput
  ): Promise<ArtifactFrameGrantRecord | null> {
    const grant = this.frameGrants.get(artifactKey(input.projectId, input.tokenHash))
    return grant ? structuredClone(grant) : null
  }

  async deleteExpiredFrameGrants(input: DeleteExpiredArtifactFrameGrantsInput): Promise<number> {
    let deleted = 0
    for (const [key, grant] of this.frameGrants) {
      if (deleted >= input.limit) break
      if (grant.projectId !== input.projectId || grant.expiresAt >= input.expiredBefore) continue
      this.frameGrants.delete(key)
      deleted += 1
    }
    return deleted
  }

  async getState(input: ArtifactStateKeyInput): Promise<ArtifactStateEntry | null> {
    const entry = this.state.get(stateKey(input))?.get(input.key)
    return entry ? structuredClone(entry) : null
  }

  async setState(input: SetArtifactStateInput): Promise<void> {
    if (!this.artifacts.has(artifactKey(input.projectId, input.artifactId))) {
      throw artifactStorageErrors.notFound(input.artifactId)
    }
    const kept = this.state.get(stateKey(input)) ?? new Map<string, ArtifactStateEntry>()
    const others = [...kept.values()].filter((entry) => entry.key !== input.key)
    const sizeBytes = artifactStateBytes(input.value)
    checkArtifactStateWrite({
      key: input.key,
      valueBytes: sizeBytes,
      others: {
        keys: others.length,
        bytes: others.reduce((total, entry) => total + entry.sizeBytes, 0),
      },
    })
    kept.set(input.key, {
      key: input.key,
      value: input.value,
      sizeBytes,
      updatedAt: new Date(input.updatedAt),
    })
    this.state.set(stateKey(input), kept)
  }

  async deleteState(input: ArtifactStateKeyInput): Promise<boolean> {
    return this.state.get(stateKey(input))?.delete(input.key) ?? false
  }

  async listState(input: ArtifactStateScope): Promise<ArtifactStateEntry[]> {
    const kept = [...(this.state.get(stateKey(input))?.values() ?? [])]
    // Code-unit order, as SQLite compares text.
    return structuredClone(kept.sort((left, right) => (left.key < right.key ? -1 : 1)))
  }

  async clearState(input: ArtifactStateScope): Promise<number> {
    const count = this.state.get(stateKey(input))?.size ?? 0
    this.state.delete(stateKey(input))
    return count
  }

  async listBoardPreviews(
    input: ListArtifactBoardPreviewsInput
  ): Promise<ArtifactBoardPreviewRecord[]> {
    const keys = new Set(input.renderKeys)
    const kept = [...this.boardPreviews.values()].filter(
      (preview) => preview.projectId === input.projectId && keys.has(preview.renderKey)
    )

    // By key, mode, then size, in code-unit order, as SQLite compares text.
    const order = (preview: ArtifactBoardPreviewRecord) =>
      `${preview.renderKey}\0${preview.theme}\0${preview.size}`
    return structuredClone(kept.sort((left, right) => (order(left) < order(right) ? -1 : 1)))
  }

  async putBoardPreviews(input: PutArtifactBoardPreviewsInput): Promise<void> {
    for (const preview of input.previews) {
      const key = `${input.projectId}\0${preview.renderKey}\0${preview.theme}\0${preview.size}`
      if (this.boardPreviews.has(key)) continue

      this.boardPreviews.set(key, structuredClone({ projectId: input.projectId, ...preview }))
    }
  }

  async createComment(input: CreateArtifactCommentInput): Promise<ArtifactCommentRecord> {
    const key = artifactKey(input.projectId, input.artifactId)
    const stored = this.artifacts.get(key)
    if (!stored) throw artifactStorageErrors.notFound(input.artifactId)

    if (input.parentId !== undefined) {
      const parent = stored.comments.find((each) => each.id === input.parentId)
      if (!parent || parent.parentId !== undefined) {
        throw artifactStorageErrors.commentNotFound(input.artifactId, input.parentId)
      }
    }
    if (stored.comments.length >= ARTIFACT_COMMENT_LIMITS.maxComments) {
      throw artifactStorageErrors.commentsFull(input.artifactId)
    }

    // Field by field, as the SQL providers store it.
    const comment: ArtifactCommentRecord = structuredClone({
      projectId: input.projectId,
      artifactId: input.artifactId,
      id: input.id,
      ...(input.parentId === undefined ? {} : { parentId: input.parentId }),
      anchor: {
        ...(input.anchor.board === undefined ? {} : { board: input.anchor.board }),
        ...(input.anchor.element === undefined ? {} : { element: input.anchor.element }),
        ...(input.anchor.label === undefined ? {} : { label: input.anchor.label }),
        revision: input.anchor.revision,
      },
      body: input.body,
      author: input.author,
      createdAt: input.createdAt,
    })
    this.artifacts.set(key, { ...stored, comments: [...stored.comments, comment] })
    return structuredClone(comment)
  }

  async getComment(input: ArtifactCommentKey): Promise<ArtifactCommentRecord | null> {
    const stored = this.artifacts.get(artifactKey(input.projectId, input.artifactId))
    const comment = stored?.comments.find((each) => each.id === input.id)
    return comment ? structuredClone(comment) : null
  }

  async listComments(input: GetArtifactInput): Promise<ArtifactCommentRecord[]> {
    const stored = this.artifacts.get(artifactKey(input.projectId, input.id))
    // By when, and those made in the same instant as they were made: a stable sort keeps them.
    const ordered = [...(stored?.comments ?? [])].sort(
      (left, right) => left.createdAt.getTime() - right.createdAt.getTime()
    )
    return structuredClone(ordered)
  }

  async resolveComment(input: ResolveArtifactCommentInput): Promise<ArtifactCommentRecord | null> {
    const key = artifactKey(input.projectId, input.artifactId)
    const stored = this.artifacts.get(key)
    const comment = stored?.comments.find((each) => each.id === input.id)
    if (!stored || !comment) return null

    const { resolvedAt: _at, resolvedBy: _by, ...open } = comment
    const next: ArtifactCommentRecord = input.resolved
      ? {
          ...open,
          resolvedAt: new Date(input.resolved.at),
          resolvedBy: structuredClone(input.resolved.by),
        }
      : open
    this.artifacts.set(key, {
      ...stored,
      comments: stored.comments.map((each) => (each.id === input.id ? next : each)),
    })
    return structuredClone(next)
  }

  async deleteComment(input: ArtifactCommentKey): Promise<boolean> {
    const key = artifactKey(input.projectId, input.artifactId)
    const stored = this.artifacts.get(key)
    if (!stored?.comments.some((each) => each.id === input.id)) return false

    // Its replies go with it.
    this.artifacts.set(key, {
      ...stored,
      comments: stored.comments.filter(
        (each) => each.id !== input.id && each.parentId !== input.id
      ),
    })
    return true
  }

  async delete(input: DeleteArtifactInput): Promise<boolean> {
    return this.deleteArtifact(artifactKey(input.projectId, input.id))
  }

  snapshot(): InMemoryArtifactSnapshot {
    return structuredClone({
      artifacts: this.artifacts,
      frameGrants: this.frameGrants,
      state: this.state,
      boardPreviews: this.boardPreviews,
    })
  }

  restore(snapshot: InMemoryArtifactSnapshot): void {
    const restored = structuredClone(snapshot)
    this.artifacts = new Map(restored.artifacts)
    this.frameGrants = new Map(restored.frameGrants)
    this.state = new Map([...restored.state].map(([key, kept]) => [key, new Map(kept)]))
    this.boardPreviews = new Map(restored.boardPreviews)
  }

  /**
   * Deletes an artifact with its frame grants and what it keeps for its readers, as the SQL
   * providers' cascade does.
   */
  private deleteArtifact(key: string): boolean {
    for (const [grantKey, grant] of this.frameGrants) {
      if (artifactKey(grant.projectId, grant.artifactId) === key) this.frameGrants.delete(grantKey)
    }
    for (const kept of this.state.keys()) {
      if (kept.startsWith(`${key}\0`)) this.state.delete(kept)
    }
    return this.artifacts.delete(key)
  }
}

function latestOf(stored: StoredArtifact): ArtifactVersionRecord {
  const latest = stored.versions.at(-1)
  if (!latest) throw new Error(`[Sixb] Artifact '${stored.record.id}' has no version.`)
  return latest
}

/** Refuses a write made from a revision the artifact has moved past. */
function assertBase(stored: StoredArtifact, baseRevision: number | undefined): void {
  if (baseRevision === undefined || baseRevision === stored.record.revision) return

  const latest = latestOf(stored)
  throw artifactStorageErrors.moved(stored.record.id, baseRevision, {
    version: latest.version,
    revision: latest.revision,
    author: structuredClone(latest.author),
    ...(latest.frozenBy ? { frozenBy: structuredClone(latest.frozenBy) } : {}),
  })
}

function versionRecord(
  projectId: string,
  artifactId: string,
  input: {
    readonly version: number
    readonly revision: number
    readonly content: ArtifactVersionInput
    readonly createdAt: Date
  }
): ArtifactVersionRecord {
  // Field by field, as the SQL providers store it: nothing else a caller passes is kept.
  const { content } = input
  return structuredClone({
    projectId,
    artifactId,
    version: input.version,
    revision: input.revision,
    title: content.title,
    entry: content.entry,
    files: content.files,
    outline: content.outline,
    references: content.references,
    author: content.author,
    ...(content.origin ? { origin: content.origin } : {}),
    createdAt: input.createdAt,
    updatedAt: content.updatedAt,
  })
}

/**
 * The artifact once content is written to its latest version: in place while it is open, as the
 * next version when it is frozen.
 */
function written(
  stored: StoredArtifact,
  content: ArtifactVersionInput,
  document: FileRef | undefined
): StoredArtifact {
  const { record } = stored
  const latest = latestOf(stored)
  const revision = record.revision + 1

  const opens = latest.frozenAt !== undefined
  const version = versionRecord(record.projectId, record.id, {
    version: opens ? stored.nextVersion : latest.version,
    revision,
    content,
    createdAt: opens ? content.updatedAt : latest.createdAt,
  })

  return {
    ...stored,
    record: {
      ...record,
      title: version.title,
      latestVersion: version.version,
      revision,
      updatedAt: new Date(content.updatedAt),
      ...(document ? { document: { file: structuredClone(document), revision } } : {}),
    },
    versions: opens ? [...stored.versions, version] : [...stored.versions.slice(0, -1), version],
    nextVersion: opens ? stored.nextVersion + 1 : stored.nextVersion,
  }
}

/** The artifact with a restore point of its latest version, past the oldest it keeps. */
function withRestorePoint(
  stored: StoredArtifact,
  input: {
    readonly reason: ArtifactRestorePointReason
    readonly turnRunId?: string
    readonly createdAt: Date
  }
): StoredArtifact {
  const {
    projectId,
    artifactId,
    version,
    revision,
    frozenAt,
    frozenBy: _frozenBy,
    createdAt: _,
    ...content
  } = latestOf(stored)
  const point: ArtifactRestorePointRecord = structuredClone({
    projectId,
    artifactId,
    revision,
    version,
    frozen: frozenAt !== undefined,
    ...content,
    reason: input.reason,
    ...(input.turnRunId === undefined ? {} : { turnRunId: input.turnRunId }),
    createdAt: input.createdAt,
  })

  return {
    ...stored,
    restorePoints: [point, ...stored.restorePoints].slice(0, ARTIFACT_RESTORE_POINTS),
  }
}

/**
 * The artifact as a turn's restore point holds it, at a new revision: an open version takes its
 * content back, and a version the turn opened past a frozen one is dropped.
 */
function undo(
  stored: StoredArtifact,
  point: ArtifactRestorePointRecord,
  document: FileRef | undefined
): StoredArtifact | null {
  const versions = stored.versions.filter((version) => version.version <= point.version)
  const target = versions.at(-1)
  if (target?.version !== point.version) return null

  const revision = stored.record.revision + 1
  const version: ArtifactVersionRecord = point.frozen
    ? { ...target, revision }
    : versionRecord(target.projectId, target.artifactId, {
        version: target.version,
        revision,
        content: {
          title: point.title,
          entry: point.entry,
          files: point.files,
          outline: point.outline,
          references: point.references,
          author: point.author,
          ...(point.origin ? { origin: point.origin } : {}),
          updatedAt: point.updatedAt,
        },
        createdAt: target.createdAt,
      })

  const { record } = stored
  return {
    ...stored,
    record: {
      ...record,
      title: version.title,
      latestVersion: version.version,
      revision,
      updatedAt: new Date(Math.max(point.updatedAt.getTime(), target.frozenAt?.getTime() ?? 0)),
      ...(document ? { document: { file: structuredClone(document), revision } } : {}),
    },
    versions: [...versions.slice(0, -1), version],
  }
}

/**
 * The artifact without the turn's writes, and once undone to the turn's restore point, without
 * that point and the links the turn made.
 */
function forgetTurn(
  stored: StoredArtifact,
  turnRunId: string,
  { undone }: { readonly undone: boolean }
): StoredArtifact {
  const turnWrites = new Map(stored.turnWrites)
  turnWrites.delete(turnRunId)

  return {
    ...stored,
    restorePoints: undone
      ? stored.restorePoints.filter((point) => point.turnRunId !== turnRunId)
      : stored.restorePoints,
    turnWrites,
    threads: undone
      ? new Map(
          [...stored.threads].filter(([, link]) => link.copied || link.linkedByRunId !== turnRunId)
        )
      : stored.threads,
  }
}

/** The artifact once its origin's thread shares it, by the turn that wrote from there. */
function sharedIn(
  stored: StoredArtifact,
  content: ArtifactVersionInput,
  turnRunId: string | undefined
): StoredArtifact {
  const threadId = content.origin?.threadId
  if (!threadId || stored.threads.has(threadId)) return stored

  const link: ThreadLink = {
    sharedAt: new Date(content.updatedAt),
    copied: false,
    ...(turnRunId === undefined ? {} : { linkedByRunId: turnRunId }),
  }
  return { ...stored, threads: new Map(stored.threads).set(threadId, link) }
}

/** The artifact once a turn wrote it, with the revision it left; the newest turns are kept. */
function turnWrote(
  stored: StoredArtifact,
  turnRunId: string | undefined,
  { created }: { readonly created: boolean }
): StoredArtifact {
  if (turnRunId === undefined) return stored

  const earlier = stored.turnWrites.get(turnRunId)
  const write: ArtifactTurnWriteRecord = {
    artifactId: stored.record.id,
    created: earlier?.created ?? created,
    revision: stored.record.revision,
    writes: (earlier?.writes ?? 0) + 1,
  }
  const others = [...stored.turnWrites].filter(([turn]) => turn !== turnRunId)
  const kept = [[turnRunId, write] as const, ...others]
    .sort(([, left], [, right]) => right.revision - left.revision)
    .slice(0, ARTIFACT_RESTORE_POINTS)

  return { ...stored, turnWrites: new Map(kept) }
}

function published(stored: StoredArtifact): PublishedArtifactVersion {
  return structuredClone({ artifact: stored.record, version: latestOf(stored) })
}

function artifactKey(projectId: string, id: string): string {
  return `${projectId}\0${id}`
}

/** An artifact's key, then its reader's. */
function stateKey(scope: {
  readonly projectId: string
  readonly artifactId: string
  readonly principal: Principal
}): string {
  return `${artifactKey(scope.projectId, scope.artifactId)}\0${scope.principal.type}\0${scope.principal.id}`
}

/** Whether an address names the artifact `artifact:<id>` is, at any version, file, or part. */
function refersTo(address: string, prefix: string): boolean {
  return address.startsWith(prefix) && /^(?:$|[@/#])/.test(address.slice(prefix.length))
}
