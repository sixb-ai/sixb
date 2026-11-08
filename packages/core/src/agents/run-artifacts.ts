import { BOARD_PREVIEW_JOB } from "../artifacts/canvas-display"
import { ArtifactRequestError } from "../artifacts/errors"
import { announceArtifactUpdates } from "../artifacts/events"
import {
  type ArtifactsRuntime,
  artifactAccessRule,
  artifactPreviewRequester,
  artifactQueryChecker,
} from "../artifacts/execution"
import type { ArtifactKind } from "../artifacts/kinds"
import { withMergedWrite } from "../artifacts/publish/merge"
import {
  type BoardPreviewInput,
  missingBoardPreviews,
  type RefusedBoardPreview,
  storeBoardPreviews,
} from "../artifacts/publish/previews"
import {
  artifactVersionWarnings,
  type PublishedArtifact,
  prepareArtifactVersion,
  storeArtifactVersion,
} from "../artifacts/publish/publish"
import type { ArtifactThemeMode } from "../artifacts/theme"
import { type Principal, principalsEqual } from "../auth/types"
import type { DomainEventLog } from "../events/service"
import type { Sixb } from "../runtime/sixb"
import type { Storage } from "../storage"
import type { AgentStorage, ConversationAgentRunRecord, SubagentRunRecord } from "../storage/agents"
import type {
  ArtifactFile,
  ArtifactRecord,
  ArtifactTurnWriteRecord,
  ArtifactVersionRecord,
} from "../storage/artifacts/types"
import { assertAgentRunOwned } from "./run-fence"
import { conversationThreadId } from "./thread-access"

// A run's artifacts are its conversation's. It reads them as its requester, and what it publishes
// lands in the conversation, owned by the conversation's owner. The worker reaches this through the
// run's session; the API, for a request with the run's token. Both apply the same rules here.

/**
 * What a run reads and publishes of artifacts, as its requester: it lists its conversation's, reads
 * any its requester reads, and publishes into its conversation.
 */
export interface AgentRunArtifacts {
  /** The artifacts the conversation shares, most recently updated first. */
  list(input: { readonly limit: number }): Promise<readonly ArtifactRecord[]>
  getVersion: ArtifactsRuntime["getVersion"]
  listVersions: ArtifactsRuntime["listVersions"]
  query: ArtifactsRuntime["query"]
  /**
   * The artifact, when the run may write it: its requester owns it, or the conversation shares it
   * and they take part. Another is `null`, even one they could update from another conversation:
   * writing it here would share it in this one.
   */
  updatable(artifactId: string): Promise<ArtifactRecord | null>
  /**
   * Publish as the run: a new artifact owned by the conversation's owner, or the latest version of
   * an updatable one, authored by the requester, with the run and its conversation as origin. A
   * write replaces the open version's content, or opens the next version after a frozen one; the
   * turn's first write to an artifact keeps a restore point, and a retry of the turn undoes its
   * writes. Nothing is stored once the run lost its execution ({@link AgentExecutionLostError}),
   * or a child's parent ended. Refusals are {@link ArtifactRequestError}s.
   */
  publish(input: AgentRunArtifactPublish): Promise<PublishedArtifact>
  /**
   * The artifacts the run's turn wrote, its sub-agents' writes among them, each with the revision
   * the turn's last write left it at.
   */
  turnWrites(): Promise<readonly ArtifactTurnWriteRecord[]>
  /**
   * Keeps the pictures the run took of the boards of a version it wrote, as their previews: its
   * requester authored the content, and the pictures show what they can see. Refuses any other
   * version, and one written again since. Each picture stands alone: those not kept are
   * returned, with why. Creating the version since leaves its content, and its pictures.
   */
  storePreviews(input: AgentRunBoardPreviews): Promise<readonly RefusedBoardPreview[]>
  /**
   * The boards of a version the run wrote still without a picture, and the modes each misses: a
   * board it kept as it was keeps the pictures it had. Refuses any other version, and one written
   * again since.
   */
  missingPreviews(input: AgentRunVersion): Promise<readonly AgentRunMissingPreview[]>
}

/** A version of an artifact, as one of the run's writes left its content. */
export interface AgentRunVersion {
  readonly artifactId: string
  readonly version: number
  /** The version's `updatedAt` after the write: a content written again since has another. */
  readonly updatedAt: Date
}

/** The pictures a run took of a version's boards. */
export interface AgentRunBoardPreviews extends AgentRunVersion {
  readonly previews: readonly BoardPreviewInput[]
}

/** A board of a version without a picture in these modes. */
export interface AgentRunMissingPreview {
  readonly board: string
  readonly themes: readonly ArtifactThemeMode[]
}

/** A version a run publishes: of a new artifact of `kind`, or of the artifact `artifactId`. */
export type AgentRunArtifactPublish = {
  readonly title: string
  readonly files: readonly ArtifactFile[]
  /**
   * The publisher renders the version's boards itself, as the publish tool's layout check does,
   * and hands their pictures over with `storePreviews`. The worker then renders only what is still
   * missing, after a grace period, and without the version's query answers, which the check read.
   * Any other publish, such as a command in the sandbox, has its queries answered at once.
   */
  readonly rendersPreviews?: boolean
} & (
  | { readonly kind: ArtifactKind }
  | {
      readonly artifactId: string
      /** The artifact's kind, when the caller names one: another is refused. */
      readonly kind?: ArtifactKind
      /**
       * The revision this content was made from: publishing fails with `artifact_moved` past it,
       * unless it is a canvas's, which takes what changed from `baseFiles` into what it holds now.
       */
      readonly baseRevision?: number
      /** The files of `baseRevision`: the copy the run started from. */
      readonly baseFiles?: readonly ArtifactFile[]
    }
)

export interface AgentRunArtifactsHost {
  readonly projectId: string
  readonly storage: Storage
  /** Where `artifact.updated` goes once a write to an artifact is stored. */
  readonly domainEvents: Pick<DomainEventLog, "emit">
}

/** The SDK a run acts through, bound to its execution: as its requester. */
export type AgentRunSdk = Pick<Sixb, "artifacts" | "blobs" | "execution">

/** The run that publishes: a conversation's turn, or a child of one. */
export type AgentRunArtifactsRun =
  | Pick<ConversationAgentRunRecord, "id" | "projectId" | "kind" | "threadId">
  | Pick<SubagentRunRecord, "id" | "projectId" | "kind" | "threadId" | "parentRunId">

export function agentRunArtifacts(
  host: AgentRunArtifactsHost,
  run: AgentRunArtifactsRun,
  executionToken: string,
  sdk: () => Promise<AgentRunSdk>
): AgentRunArtifacts {
  const { projectId, storage } = host
  let publisher: Promise<Publisher> | undefined
  const publisherOf = () => {
    publisher ??= readPublisher(host, run).catch((error: unknown) => {
      publisher = undefined
      throw error
    })
    return publisher
  }
  const fence = { projectId, id: run.id, executionToken }
  // A child writes as the turn it works under: one restore point per turn, undone by its retry.
  const turnRunId = run.kind === "subagent" ? run.parentRunId : run.id

  const updatable = async (artifactId: string): Promise<ArtifactRecord | null> => {
    const [{ threadId }, { artifacts: reader }] = await Promise.all([publisherOf(), sdk()])
    const artifact = await requireArtifacts(storage).get({ projectId, id: artifactId })
    if (!artifact) return null
    const access = await artifactAccessRule(reader, storage).publishAccess(artifact, threadId)
    return access === "owner" || access === "update" ? artifact : null
  }

  return {
    async list({ limit }) {
      const [{ threadId }, { artifacts }] = await Promise.all([publisherOf(), sdk()])
      return (await artifacts.list({ threadId, limit })).artifacts
    },
    getVersion: async (...args) => (await sdk()).artifacts.getVersion(...args),
    listVersions: async (...args) => (await sdk()).artifacts.listVersions(...args),
    query: async (...args) => (await sdk()).artifacts.query(...args),
    updatable,

    async publish(input) {
      const [{ threadId, owner }, { artifacts: reader, blobs, execution }] = await Promise.all([
        publisherOf(),
        sdk(),
      ])
      // Whoever asked for the turn is each version's author.
      const author = execution.requestedBy ?? owner
      await assertAgentRunOwned(requireAgents(storage), fence)

      let kind = input.kind
      if ("artifactId" in input) {
        const artifact = await updatable(input.artifactId)
        if (!artifact) {
          throw new ArtifactRequestError(
            "artifact_not_found",
            `[Sixb] There is no artifact '${input.artifactId}' in this conversation.`
          )
        }
        kind ??= artifact.kind
      }
      if (!kind) throw new Error("[Sixb] A new artifact needs a kind.")

      // Validation reads the files back and parses them, so it runs before the transaction, which
      // checks again that the run holds its conversation and the requester may still publish.
      const context = { projectId, storage: requireArtifacts(storage), blobStorage: blobs }
      const reading = artifactAccessRule(reader, storage)
      const write = async (files: readonly ArtifactFile[], baseRevision?: number) => {
        const prepared = await prepareArtifactVersion(context, {
          ...("artifactId" in input
            ? {
                artifactId: input.artifactId,
                ...(baseRevision === undefined ? {} : { baseRevision }),
              }
            : {}),
          kind,
          title: input.title,
          files,
          author,
          owner,
          readable: async (artifact) => (await reading.accessTo(artifact)) !== "none",
          // As the requester, so a query never reads what they cannot.
          checkQuery: artifactQueryChecker(reader),
          origin: { threadId, runId: run.id },
          turnRunId,
        })
        const stored = await storage.transaction(async (tx) => {
          await assertAgentRunOwned(requireAgents(tx), fence)
          if (run.kind === "subagent") await assertParentActive(requireAgents(tx), run)
          if (execution.requestedBy) {
            await assertTakesPart(
              requireAgents(tx),
              { projectId, threadId, owner },
              execution.requestedBy
            )
          }
          // The owner may have deleted it since, or removed the requester from the conversation.
          return storeArtifactVersion(
            { ...context, storage: requireArtifacts(tx) },
            prepared,
            (each) => artifactAccessRule(reader, tx).publishAccess(each, threadId)
          )
        })
        return { prepared, stored }
      }

      // A canvas written since the copy the run started from is merged into, not refused.
      const { prepared, stored, merged } =
        "artifactId" in input
          ? await withMergedWrite(
              context,
              {
                artifactId: input.artifactId,
                kind,
                files: input.files,
                ...(input.baseRevision === undefined ? {} : { baseRevision: input.baseRevision }),
                ...(input.baseFiles === undefined ? {} : { baseFiles: input.baseFiles }),
              },
              async (each) => ({
                ...(await write(each.files, each.baseRevision)),
                merged: each.merged,
              })
            )
          : { ...(await write(input.files)), merged: false }
      if ("artifactId" in input) await announceArtifactUpdates(host.domainEvents, [stored.version])

      // A publisher that renders its own previews reads the query answers in its layout check, and
      // normally pictures every board: answering them here too would run each query twice. So its
      // job waits, carries none, and a board that reads one and that the check missed keeps its
      // outline. Every other publish has its answers read now, as its requester.
      await artifactPreviewRequester(reader)(
        stored.version,
        input.rendersPreviews ? { delayMs: BOARD_PREVIEW_JOB.graceMs, withoutAnswers: true } : {}
      )

      return {
        ...stored,
        warnings: await artifactVersionWarnings(context, prepared, stored),
        ...(merged ? { merged: true as const } : {}),
      }
    },

    async turnWrites() {
      return requireArtifacts(storage).listTurnWrites({ projectId, turnRunId })
    },

    async storePreviews({ previews, ...at }) {
      const [{ blobs }, version] = await Promise.all([sdk(), publishedVersion(at)])
      return storeBoardPreviews(
        { storage: requireArtifacts(storage), blobStorage: blobs },
        version,
        previews
      )
    },

    async missingPreviews(at) {
      const missing = await missingBoardPreviews(
        requireArtifacts(storage),
        await publishedVersion(at)
      )
      return missing.map(({ board, themes }) => ({ board: board.id, themes }))
    },
  }

  /**
   * Only the run that wrote a version's content pictures its boards with its author's rights, and
   * only while the version holds that content: the pictures are kept under its boards' render keys.
   * A change that leaves the content, such as creating the version, changes nothing here.
   */
  async function publishedVersion(at: AgentRunVersion): Promise<ArtifactVersionRecord> {
    const version = await requireArtifacts(storage).getVersion({
      projectId,
      artifactId: at.artifactId,
      version: at.version,
    })
    const written = at.updatedAt.getTime()
    if (!version || version.origin?.runId !== run.id || version.updatedAt.getTime() !== written) {
      throw new ArtifactRequestError(
        "not_allowed",
        `[Sixb] Version ${at.version} of artifact '${at.artifactId}' does not hold what this run wrote at ${at.updatedAt.toISOString()}.`
      )
    }
    return version
  }
}

interface Publisher {
  /** The conversation's thread: a child publishes into its parent's. */
  readonly threadId: string
  /** The conversation's owner, who owns what the run creates. */
  readonly owner: Principal
}

async function readPublisher(
  host: AgentRunArtifactsHost,
  run: AgentRunArtifactsRun
): Promise<Publisher> {
  const { projectId } = host
  const agents = requireAgents(host.storage)
  const thread = await agents.threads.getById({ projectId, id: run.threadId })
  const conversation =
    thread && run.kind === "subagent"
      ? await agents.threads.getById({ projectId, id: conversationThreadId(thread) })
      : thread
  if (!conversation) {
    throw new ArtifactRequestError(
      "not_allowed",
      `[Sixb] Agent run '${run.id}' has no conversation to publish artifacts in.`
    )
  }
  return { threadId: conversation.id, owner: conversation.ownerPrincipal }
}

/** The requester may have been removed from the conversation while the run went on. */
async function assertTakesPart(
  agents: AgentStorage,
  conversation: {
    readonly projectId: string
    readonly threadId: string
    readonly owner: Principal
  },
  requester: Principal
): Promise<void> {
  if (principalsEqual(requester, conversation.owner)) return
  const participants = await agents.threads.listParticipants({
    projectId: conversation.projectId,
    threadIds: [conversation.threadId],
  })
  if (participants.some((participant) => principalsEqual(participant.principal, requester))) return
  throw new ArtifactRequestError(
    "not_allowed",
    "[Sixb] The requester no longer takes part in this conversation, so nothing was published."
  )
}

async function assertParentActive(
  agents: AgentStorage,
  run: Extract<AgentRunArtifactsRun, { readonly kind: "subagent" }>
): Promise<void> {
  const parent = await agents.runs.getById({ projectId: run.projectId, id: run.parentRunId })
  // A cancel recorded on the parent ends it, as the run token already reads it.
  if ((parent?.status === "queued" || parent?.status === "running") && !parent.cancelRequestedAt) {
    return
  }

  throw new ArtifactRequestError(
    "not_allowed",
    "[Sixb] The parent Agent run has ended, so nothing was published."
  )
}

function requireArtifacts(storage: Storage) {
  if (!storage.artifacts) {
    throw new ArtifactRequestError(
      "storage_unavailable",
      "[Sixb] Artifacts need storage that supports them."
    )
  }
  return storage.artifacts
}

function requireAgents(storage: Storage): AgentStorage {
  if (!storage.agents) throw new Error("[Sixb] Agent runs need storage that holds them.")
  return storage.agents
}
