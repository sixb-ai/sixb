import { ArtifactRequestError, type BlobStorage, type Storage } from "@sixb/core"
import {
  AGENT_AWARENESS_FIELD,
  type ArtifactAgentPresence,
  type ArtifactLiveAccess,
  type ArtifactLiveSaveState,
  type ArtifactLiveServerMessage,
  type ArtifactLiveUser,
  decodeLiveData,
  documentFiles,
  encodeLiveData,
} from "@sixb/core/artifacts/live"
import type { Broker, BrokerRecord } from "@sixb/core/broker"
import {
  AGENT_PRESENCE_MS,
  artifactLiveStream,
  loadArtifactDocument,
  mergeIntoDocument,
  parseArtifactLiveRecord,
  readDocumentState,
  readLiveFiles,
  sameArtifactFiles,
  storeLiveFiles,
} from "@sixb/core/internal/artifacts/live"
import type { Sixb } from "@sixb/core/internal/request-execution"
import type { ArtifactFile, ArtifactKind } from "@sixb/core/storage"
import * as decoding from "lib0/decoding"
import * as encoding from "lib0/encoding"
import * as awarenessProtocol from "y-protocols/awareness"
import * as syncProtocol from "y-protocols/sync"
import * as Y from "yjs"
import { MAX_AWARENESS_CLIENTS, vouchedAwareness } from "./awareness"

// One artifact held live on this server: its Yjs document as storage keeps it, the connections
// that edit or watch it, the other servers that hold it too, and the write-back of what they
// change. See README.md.

/** After the last change, how long the document waits before it writes itself back. */
export const SAVE_IDLE_MS = 1_500
/** How long changes made without pause wait, at most, to be written back. */
export const SAVE_MAX_MS = 10_000
/** How long an editor's right to change the artifact holds before it is read again. */
export const ACCESS_RECHECK_MS = 2_000
/** The first wait before a failed write-back is tried again; it doubles, up to the next. */
const RETRY_MS = 2_000
const RETRY_MAX_MS = 30_000
/** How many times a document nobody holds any more tries to write itself back before it gives up. */
const RETRIES_UNHELD = 5
/** How old another server's awareness update may be for a server joining late to apply it. */
const AWARENESS_REPLAY_MS = awarenessProtocol.outdatedTimeout

/** A connection, as a room sees it: who it is, through its SDK, and how to reach it. */
export interface LiveConnection {
  readonly id: string
  /** The connection's SDK, as the person who opened it: every write goes through it. */
  readonly sixb: Sixb
  send(message: ArtifactLiveServerMessage): void
}

export interface LiveRoomHost {
  readonly projectId: string
  readonly storage: Pick<Storage, "artifacts" | "auth">
  readonly blobStorage: Pick<BlobStorage, "open" | "put">
  readonly broker: Broker
  /** This server, among those that hold the artifact live. */
  readonly instance: string
}

interface Member {
  readonly connection: LiveConnection
  /** Who the connection is, in every awareness state it sets. */
  readonly user: ArtifactLiveUser
  access: ArtifactLiveAccess
  /** When the right to edit was last read. */
  checkedAt: number
  /** The awareness clients the connection set. */
  readonly clients: Set<number>
}

/** The open version the document last took in: what a write-back is based on. */
interface Synced {
  readonly revision: number
  readonly title: string
  readonly files: readonly ArtifactFile[]
}

/** The origin of what the server takes from storage: written already, never written back. */
const MERGED = Symbol("merged")
/**
 * The origin of what another server holding the artifact heard from its editors: shown here,
 * never shared again, and written back by that server.
 */
const REMOTE = Symbol("remote")
/** The origin of a connection's awareness taken back as it leaves: shared, so others see it go. */
const LEFT = Symbol("left")

export class LiveRoom {
  readonly doc: Y.Doc
  readonly awareness: awarenessProtocol.Awareness
  private readonly members = new Map<string, Member>()
  private synced: Synced
  private dirty = false
  private author: LiveConnection | undefined
  private state: ArtifactLiveSaveState = "saved"
  private error: string | undefined
  private attempts = 0
  private idle: ReturnType<typeof setTimeout> | undefined
  private deadline: ReturnType<typeof setTimeout> | undefined
  private retry: ReturnType<typeof setTimeout> | undefined
  private queue: Promise<void> = Promise.resolve()
  private readonly agents = new Map<
    string,
    { readonly boards: Set<string>; expiry: ReturnType<typeof setTimeout> }
  >()
  /** The awareness clients other servers speak for. */
  private readonly remoteClients = new Set<number>()
  private unsubscribe: (() => void) | undefined
  private closed = false

  private constructor(
    private readonly host: LiveRoomHost,
    readonly artifactId: string,
    private readonly kind: ArtifactKind,
    doc: Y.Doc,
    synced: Synced,
    private readonly onClose: (room: LiveRoom) => void
  ) {
    this.synced = synced
    this.doc = doc
    this.awareness = new awarenessProtocol.Awareness(this.doc)
    // The server is no one: it is here only for the Agent, while a turn changes boards.
    this.awareness.setLocalState(null)

    this.doc.on("update", (update: Uint8Array, origin: unknown) => this.updated(update, origin))
    this.awareness.on("update", (changes: AwarenessChanges, origin: unknown) =>
      this.presenceChanged(changes, origin)
    )
  }

  /**
   * The room of an artifact, its document loaded as storage keeps it; a reason instead for an
   * artifact that is gone or is not edited live. Whoever opens it must already have been allowed
   * to read it.
   */
  static async open(
    host: LiveRoomHost,
    artifactId: string,
    onClose: (room: LiveRoom) => void
  ): Promise<LiveRoom | "not_found" | "not_live"> {
    const storage = requireArtifacts(host)
    const artifact = await storage.get({ projectId: host.projectId, id: artifactId })
    if (!artifact) return "not_found"
    if (artifact.kind !== "canvas") return "not_live"

    const version = await storage.getVersion({
      projectId: host.projectId,
      artifactId,
      version: artifact.latestVersion,
    })
    if (!version) return "not_found"

    const doc = await loadArtifactDocument(host.blobStorage, artifact, version.files)
    const room = new LiveRoom(
      host,
      artifactId,
      artifact.kind,
      doc,
      { revision: version.revision, title: version.title, files: version.files },
      onClose
    )
    // What editors on other servers changed since the last write-back is on the live stream.
    await room.follow()
    return room
  }

  get isClosed(): boolean {
    return this.closed
  }

  get revision(): number {
    return this.synced.revision
  }

  /** Adds a connection, which gets the document and who is here; sync is the client's to start. */
  join(connection: LiveConnection, access: ArtifactLiveAccess, user: ArtifactLiveUser): void {
    this.members.set(connection.id, {
      connection,
      user,
      access,
      checkedAt: Date.now(),
      clients: new Set(),
    })
    connection.send({
      type: "joined",
      artifactId: this.artifactId,
      access,
      revision: this.synced.revision,
      user,
    })

    const encoder = encoding.createEncoder()
    syncProtocol.writeSyncStep1(encoder, this.doc)
    this.sendSync(connection, encoding.toUint8Array(encoder))

    const clients = [...this.awareness.getStates().keys()]
    if (clients.length > 0) {
      connection.send({
        type: "awareness",
        artifactId: this.artifactId,
        data: encodeLiveData(awarenessProtocol.encodeAwarenessUpdate(this.awareness, clients)),
      })
    }
    connection.send(this.status())
  }

  /**
   * Removes a connection and what it said of itself. The last editor to leave writes the document
   * back at once, and the last connection closes the room once nothing waits to be written: a
   * client that comes back loads the same history from storage.
   */
  leave(connectionId: string): void {
    const member = this.members.get(connectionId)
    if (!member) return

    this.members.delete(connectionId)
    awarenessProtocol.removeAwarenessStates(this.awareness, [...member.clients], LEFT)
    if (![...this.members.values()].some((each) => each.access === "edit")) this.save()
    this.closeWhenDone()
  }

  /**
   * A y-protocols sync message from a connection. One that watches may ask for the document, never
   * change it; one that edits is read again at most every {@link ACCESS_RECHECK_MS}.
   */
  async sync(connectionId: string, bytes: Uint8Array): Promise<void> {
    const member = this.members.get(connectionId)
    if (!member) return

    const type = decoding.readVarUint(decoding.createDecoder(bytes))
    if (type !== syncProtocol.messageYjsSyncStep1 && !(await this.mayEdit(member))) {
      member.connection.send({
        type: "error",
        artifactId: this.artifactId,
        message: "[SixbServer] You watch this artifact: your changes are not kept.",
      })
      return
    }

    const encoder = encoding.createEncoder()
    syncProtocol.readSyncMessage(decoding.createDecoder(bytes), encoder, this.doc, member)
    if (encoding.length(encoder) > 0)
      this.sendSync(member.connection, encoding.toUint8Array(encoder))

    // Answering step 1, the server asks for what the client holds that it does not: a client
    // that edited offline, or before a reconnect, sends it back.
    if (type === syncProtocol.messageYjsSyncStep1 && member.access === "edit") {
      const ask = encoding.createEncoder()
      syncProtocol.writeSyncStep1(ask, this.doc)
      this.sendSync(member.connection, encoding.toUint8Array(ask))
    }
  }

  /**
   * An awareness update from a connection: what it points at, under the name the server knows it
   * by, for the clients it may speak for.
   */
  presence(connectionId: string, data: string): void {
    const member = this.members.get(connectionId)
    const bytes = decodeLiveData(data)
    if (!member || !bytes) return

    const vouched = vouchedAwareness(bytes, {
      user: member.user,
      mayUse: (client) => this.mayUse(member, client),
    })
    if (vouched) awarenessProtocol.applyAwarenessUpdate(this.awareness, vouched, member)
  }

  /**
   * The artifact was written at `revision`, by this room or anyone else. Every write is made into
   * the stored document, which the room takes in: what its editors changed meanwhile stays.
   */
  written(revision: number): void {
    if (revision <= this.synced.revision) return
    this.enqueue(() => this.reconcile(revision))
  }

  /** Writes the document back now, if it changed. */
  save(): void {
    this.clearTimers()
    this.enqueue(() => this.flush())
  }

  /** Settles once what the room has queued, a write-back or a merge, is done. */
  settled(): Promise<void> {
    return this.queue
  }

  /** Stops the room. What it still holds unwritten is the caller's to save first. */
  close(): void {
    if (this.closed) return
    this.closed = true
    this.clearTimers()
    for (const agent of this.agents.values()) clearTimeout(agent.expiry)
    this.unsubscribe?.()
    this.awareness.destroy()
    this.doc.destroy()
    this.onClose(this)
  }

  // ── The document ────────────────────────────────────────────────────

  private updated(update: Uint8Array, origin: unknown): void {
    const message = encoding.createEncoder()
    syncProtocol.writeUpdate(message, update)
    const data = encoding.toUint8Array(message)
    for (const member of this.members.values()) {
      if (member !== origin) this.sendSync(member.connection, data)
    }

    // What an editor here changed reaches the other servers at once, and waits to be written back
    // from here; what came from storage or another server is written already, or will be there.
    if (!(origin instanceof Object && this.isMember(origin))) return
    this.changed(origin)
    this.share("update", update)
  }

  private changed(member: Member): void {
    this.dirty = true
    this.author = member.connection
    this.setState("unsaved")

    if (this.idle) clearTimeout(this.idle)
    this.idle = setTimeout(() => this.save(), SAVE_IDLE_MS)
    this.deadline ??= setTimeout(() => this.save(), SAVE_MAX_MS)
  }

  /**
   * Writes the document back into the open version, as the last editor: a normal write, which
   * bumps the revision and tells every reader. The write carries the document itself, which
   * storage merges into its own, so whatever was written meanwhile stays, there and back. A
   * failure leaves the changes waiting, says so, and tries again.
   */
  private async flush(): Promise<void> {
    if (this.closed || !this.dirty) return this.closeWhenDone()
    const author = this.author
    if (!author) return

    const update = Y.encodeStateAsUpdate(this.doc)
    const snapshot = documentFiles(this.doc)
    this.dirty = false
    this.setState("saving")

    try {
      const files = await storeLiveFiles(this.host.blobStorage, snapshot, this.synced.files)
      if (sameArtifactFiles(files, this.synced.files)) {
        this.saved(this.synced)
        return this.closeWhenDone()
      }

      const published = await author.sixb.artifacts.publish(this.artifactId, {
        kind: this.kind,
        title: this.synced.title,
        files,
        baseRevision: this.synced.revision,
        document: update,
      })

      // Merged with a write made meanwhile: the stored document holds it too.
      const stored = published.artifact.document
      if (published.merged && stored) {
        Y.applyUpdate(this.doc, await readDocumentState(this.host.blobStorage, stored), MERGED)
      }
      this.saved({
        revision: published.version.revision,
        title: published.version.title,
        files: published.version.files,
      })
    } catch (error) {
      this.failed(author, error)
    }
    this.closeWhenDone()
  }

  private saved(synced: Synced): void {
    this.synced = synced
    this.attempts = 0
    this.error = undefined
    this.setState(this.dirty ? "unsaved" : "saved", true)
    if (this.dirty && !this.idle) this.idle = setTimeout(() => this.save(), SAVE_IDLE_MS)
  }

  /**
   * Keeps the changes and says why they were not written. A refusal of what the document holds
   * waits for the next change; one of who wrote it is tried as another editor; anything else is
   * tried again later, and given up only once nobody holds the document any more.
   */
  private failed(author: LiveConnection, error: unknown): void {
    this.dirty = true
    this.attempts += 1
    this.error = error instanceof Error ? error.message : String(error)
    this.setState("failed", true)

    const code = error instanceof ArtifactRequestError ? error.code : undefined
    if (code === "artifact_not_found") {
      for (const member of [...this.members.values()]) {
        member.connection.send({ type: "left", artifactId: this.artifactId, reason: "not_found" })
      }
      this.members.clear()
      this.close()
      return
    }
    if (code === "not_shared" || code === "read_only" || code === "not_allowed") {
      const member = this.members.get(author.id)
      if (member) this.demote(member)
      this.author = [...this.members.values()].find((each) => each.access === "edit")?.connection
      if (this.author) this.scheduleRetry(0)
      return
    }
    if (code === "invalid_artifact" && this.members.size > 0) return

    if (this.members.size === 0 && this.attempts > RETRIES_UNHELD) {
      console.error(
        `[SixbServer] Gave up writing back the live changes to artifact '${this.artifactId}' after ${this.attempts} attempts; they are lost:`,
        error
      )
      this.dirty = false
      return
    }
    this.scheduleRetry(Math.min(RETRY_MS * 2 ** (this.attempts - 1), RETRY_MAX_MS))
  }

  private scheduleRetry(delayMs: number): void {
    if (this.retry) clearTimeout(this.retry)
    this.retry = setTimeout(() => {
      this.retry = undefined
      this.save()
    }, delayMs)
  }

  /**
   * Takes in what someone else wrote: the stored document, which shares this one's history. A
   * version written without one, by a server from before documents were kept, is merged as the
   * change from the files the room last took in.
   */
  private async reconcile(revision: number): Promise<void> {
    if (this.closed || revision <= this.synced.revision) return

    const storage = requireArtifacts(this.host)
    const artifact = await storage.get({ projectId: this.host.projectId, id: this.artifactId })
    const version =
      artifact &&
      (await storage.getVersion({
        projectId: this.host.projectId,
        artifactId: this.artifactId,
        version: artifact.latestVersion,
      }))
    if (!version) {
      for (const member of this.members.values()) {
        member.connection.send({ type: "left", artifactId: this.artifactId, reason: "not_found" })
      }
      this.members.clear()
      this.close()
      return
    }
    if (version.revision <= this.synced.revision) return

    const { blobStorage } = this.host
    if (artifact.document) {
      Y.applyUpdate(this.doc, await readDocumentState(blobStorage, artifact.document), MERGED)
    } else {
      const [base, next] = await Promise.all([
        readLiveFiles(blobStorage, this.synced.files),
        readLiveFiles(blobStorage, version.files),
      ])
      mergeIntoDocument(this.doc, base, next, MERGED)
    }
    this.synced = { revision: version.revision, title: version.title, files: version.files }
    this.setState(this.dirty ? this.state : "saved", true)
  }

  private enqueue(task: () => Promise<void>): void {
    this.queue = this.queue.then(task).catch((error: unknown) => {
      console.error(`[SixbServer] Live artifact '${this.artifactId}' failed:`, error)
    })
  }

  /** Closes the room once nobody holds it and nothing waits to be written. */
  private closeWhenDone(): void {
    if (this.members.size === 0 && !this.dirty && !this.retry) this.close()
  }

  private clearTimers(): void {
    for (const timer of [this.idle, this.deadline, this.retry]) if (timer) clearTimeout(timer)
    this.idle = undefined
    this.deadline = undefined
    this.retry = undefined
  }

  // ── Who may edit ────────────────────────────────────────────────────

  private async mayEdit(member: Member): Promise<boolean> {
    if (member.access !== "edit") return false
    if (Date.now() - member.checkedAt < ACCESS_RECHECK_MS) return true

    const access = await member.connection.sixb.artifacts.access(this.artifactId)
    member.checkedAt = Date.now()
    if (access === "owner" || access === "update") return true

    if (access === "read") this.demote(member)
    else {
      this.members.delete(member.connection.id)
      member.connection.send({ type: "left", artifactId: this.artifactId, reason: "not_shared" })
      this.closeWhenDone()
    }
    return false
  }

  private demote(member: Member): void {
    if (member.access === "watch") return
    member.access = "watch"
    member.connection.send({ type: "access", artifactId: this.artifactId, access: "watch" })
  }

  private isMember(value: object): value is Member {
    return [...this.members.values()].includes(value as Member)
  }

  /**
   * Whether a connection may speak for an awareness client: one it already speaks for, or a new
   * one nobody else does, the server's own included, up to {@link MAX_AWARENESS_CLIENTS}.
   */
  private mayUse(member: Member, client: number): boolean {
    if (member.clients.has(client)) return true
    if (client === this.doc.clientID || this.remoteClients.has(client)) return false
    if (member.clients.size >= MAX_AWARENESS_CLIENTS) return false
    return ![...this.members.values()].some((each) => each.clients.has(client))
  }

  // ── Presence ────────────────────────────────────────────────────────

  private presenceChanged(changes: AwarenessChanges, origin: unknown): void {
    const speaker =
      origin === REMOTE
        ? this.remoteClients
        : origin instanceof Object && this.isMember(origin)
          ? origin.clients
          : null
    for (const client of changes.added) speaker?.add(client)
    for (const client of changes.removed) {
      speaker?.delete(client)
      this.remoteClients.delete(client)
    }

    const changed = [...changes.added, ...changes.updated, ...changes.removed]
    const data = encodeLiveData(awarenessProtocol.encodeAwarenessUpdate(this.awareness, changed))
    for (const member of this.members.values()) {
      member.connection.send({ type: "awareness", artifactId: this.artifactId, data })
    }

    // People reach the other servers holding the artifact; the Agent's entry each server sets.
    const people = changed.filter((client) => client !== this.doc.clientID)
    if (origin === REMOTE || people.length === 0) return
    this.share("awareness", awarenessProtocol.encodeAwarenessUpdate(this.awareness, people))
  }

  /** Tells the other servers holding the artifact what an editor here changed or pointed at. */
  private share(name: "update" | "awareness", update: Uint8Array): void {
    if (this.closed) return
    // The room made sure of the stream when it started to follow it.
    const payload = { instance: this.host.instance, update: encodeLiveData(update) }
    this.host.broker
      .append({
        projectId: this.host.projectId,
        streamId: artifactLiveStream(this.artifactId).id,
        records: [{ name, payload }],
      })
      .catch((error: unknown) => {
        // The document's own update still reaches storage with the next write-back.
        console.warn(`[SixbServer] Could not share a live ${name} of '${this.artifactId}':`, error)
      })
  }

  /**
   * Reads the artifact's live stream: other servers' editors' updates and awareness, and the
   * Agent's presence. From its start, so the room takes in what was changed elsewhere since the
   * last write-back; an update it already holds changes nothing.
   */
  private async follow(): Promise<void> {
    const stream = artifactLiveStream(this.artifactId)
    await this.host.broker.ensureStream({ projectId: this.host.projectId, stream })
    this.unsubscribe = await this.host.broker.subscribe(
      { projectId: this.host.projectId, streamId: stream.id, from: "earliest" },
      (records) => {
        for (const record of records) this.heard(record)
      }
    )
  }

  private heard(record: BrokerRecord): void {
    if (this.closed) return
    const live = parseArtifactLiveRecord(record)
    if (!live) return
    const age = Date.now() - Date.parse(record.publishedAt)

    switch (live.name) {
      case "update": {
        const update = decodeLiveData(live.payload.update)
        if (live.payload.instance === this.host.instance || !update) return
        try {
          Y.applyUpdate(this.doc, update, REMOTE)
        } catch (error) {
          console.warn(
            `[SixbServer] Skipped an unreadable live update of '${this.artifactId}':`,
            error
          )
        }
        return
      }
      case "awareness": {
        const update = decodeLiveData(live.payload.update)
        if (live.payload.instance === this.host.instance || !update || age > AWARENESS_REPLAY_MS) {
          return
        }
        awarenessProtocol.applyAwarenessUpdate(this.awareness, update, REMOTE)
        return
      }
      case "agent": {
        if (age > AGENT_PRESENCE_MS) return
        const agent = this.agents.get(live.payload.runId)
        if (agent) clearTimeout(agent.expiry)
        const boards = new Set([...(agent?.boards ?? []), ...live.payload.boards])
        const expiry = setTimeout(
          () => this.agentEnded(live.payload.runId),
          AGENT_PRESENCE_MS - age
        )
        this.agents.set(live.payload.runId, { boards, expiry })
        this.showAgents()
        return
      }
      case "agent-ended":
        this.agentEnded(live.payload.runId)
        return
    }
  }

  private agentEnded(runId: string): void {
    const agent = this.agents.get(runId)
    if (!agent) return
    clearTimeout(agent.expiry)
    this.agents.delete(runId)
    this.showAgents()
  }

  /** The server's awareness entry: each Agent turn at work on the canvas, and its boards. */
  private showAgents(): void {
    if (this.closed) return
    const turns: ArtifactAgentPresence[] = [...this.agents].map(([runId, agent]) => ({
      runId,
      boards: [...agent.boards],
    }))
    this.awareness.setLocalState(turns.length === 0 ? null : { [AGENT_AWARENESS_FIELD]: turns })
  }

  // ── Messages ────────────────────────────────────────────────────────

  private sendSync(connection: LiveConnection, bytes: Uint8Array): void {
    connection.send({ type: "sync", artifactId: this.artifactId, data: encodeLiveData(bytes) })
  }

  private status(): ArtifactLiveServerMessage {
    return {
      type: "status",
      artifactId: this.artifactId,
      state: this.state,
      revision: this.synced.revision,
      ...(this.state === "failed" && this.error ? { error: this.error } : {}),
    }
  }

  private setState(state: ArtifactLiveSaveState, announce = false): void {
    if (state === this.state && !announce) return
    this.state = state
    const status = this.status()
    for (const member of this.members.values()) member.connection.send(status)
  }
}

interface AwarenessChanges {
  readonly added: readonly number[]
  readonly updated: readonly number[]
  readonly removed: readonly number[]
}

function requireArtifacts(host: LiveRoomHost) {
  const storage = host.storage.artifacts
  if (!storage) throw new Error("[SixbServer] Live artifacts need storage that holds artifacts.")
  return storage
}
