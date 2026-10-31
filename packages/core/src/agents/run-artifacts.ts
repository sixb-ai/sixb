import { ArtifactRequestError } from "../artifacts/errors"
import {
  type ArtifactsRuntime,
  artifactAccessRule,
  artifactQueryChecker,
} from "../artifacts/execution"
import type { ArtifactKind } from "../artifacts/kinds"
import {
  artifactVersionWarnings,
  type PublishedArtifact,
  prepareArtifactVersion,
  storeArtifactVersion,
} from "../artifacts/publish/publish"
import { type Principal, principalsEqual } from "../auth/types"
import type { Sixb } from "../runtime/sixb"
import type { Storage } from "../storage"
import type { AgentStorage, ConversationAgentRunRecord, SubagentRunRecord } from "../storage/agents"
import type { ArtifactFile, ArtifactRecord } from "../storage/artifacts/types"
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
   * The artifact, when the run may publish its next version: its requester owns it, or the
   * conversation shares it and they take part. Another is `null`, even one they could update from
   * another conversation: publishing here would share it in this one.
   */
  updatable(artifactId: string): Promise<ArtifactRecord | null>
  /**
   * Publish as the run: a new artifact owned by the conversation's owner, or the next version of an
   * updatable one, authored by the requester, with the run and its conversation as origin. Nothing
   * is stored once the run lost its execution ({@link AgentExecutionLostError}), or a child's
   * parent ended. Refusals are {@link ArtifactRequestError}s.
   */
  publish(input: AgentRunArtifactPublish): Promise<PublishedArtifact>
}

/** A version a run publishes: of a new artifact of `kind`, or of the artifact `artifactId`. */
export type AgentRunArtifactPublish = {
  readonly title: string
  readonly files: readonly ArtifactFile[]
} & (
  | { readonly kind: ArtifactKind }
  | {
      readonly artifactId: string
      /** The artifact's kind, when the caller names one: another is refused. */
      readonly kind?: ArtifactKind
      /** The version this one was made from: publishing fails with `artifact_moved` past it. */
      readonly baseVersion?: number
    }
)

export interface AgentRunArtifactsHost {
  readonly projectId: string
  readonly storage: Storage
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
      const prepared = await prepareArtifactVersion(context, {
        ...("artifactId" in input
          ? {
              artifactId: input.artifactId,
              ...(input.baseVersion === undefined ? {} : { baseVersion: input.baseVersion }),
            }
          : {}),
        kind,
        title: input.title,
        files: input.files,
        author,
        owner,
        readable: async (artifact) => (await reading.accessTo(artifact)) !== "none",
        // As the requester, so a query never reads what they cannot.
        checkQuery: artifactQueryChecker(reader),
        origin: { threadId, runId: run.id },
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
      return { ...stored, warnings: await artifactVersionWarnings(context, prepared, stored) }
    },
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
