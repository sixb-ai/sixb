import type { ArtifactAccessRule } from "../artifacts/access"
import { createRuntimeArtifactAccessRule } from "../artifacts/execution"
import { createSixbError } from "../errors/internal"
import type { ExecutionContext } from "../execution/types"
import type { EmbeddingModel } from "../models/embedding-model"
import { ObjectQueryExecutionError } from "../objects/query/errors"
import { normalizeVector, vectorSearchCandidateLimit } from "../objects/vectors/profile"
import type { SixbRuntimeContext } from "../runtime/types"
import type {
  AgentRunRecord,
  AgentStorage,
  AgentThreadRecord,
  AgentTurnSearchHit,
  AgentTurnSearchScope,
  SearchAgentTurnVectorsResult,
} from "../storage/agents"
import { AgentRequestError } from "./errors"
import { type AgentRunConversationStorage, agentRunConversation } from "./participants"
import type { AgentThreadAccessRule, AgentThreadView } from "./thread-access"
import { agentTurnVectorConfiguration } from "./turn-vectors/configuration"
import { TURN_CHUNK_MAX_CHARS } from "./turn-vectors/turns"

/** At most this many conversations answer one search. */
export const MAX_AGENT_THREAD_SEARCH_LIMIT = 25
const DEFAULT_LIMIT = 10
/** The turns shown of each conversation found: its best ones. */
const TURNS_PER_CONVERSATION = 3
const EXCERPT_MAX_CHARS = 600
const QUERY_EMBEDDING_TIMEOUT_MS = 30_000
/**
 * What finding a turn's artifacts reads at most: the person's messages of the turn, the runs that
 * started after it opened, and the artifacts shown.
 */
const TURN_MESSAGES_READ = 20
const TURN_RUNS_READ = 20
const TURN_ARTIFACTS_SHOWN = 10

export interface SearchAgentThreadsInput {
  /** What to look for, in the person's words: at most 8,000 characters. */
  readonly text: string
  /** Only turns from this instant on. */
  readonly since?: Date
  /** Only turns before this instant: `searchedFrom` of a result goes further back. */
  readonly until?: Date
  /** At most this many conversations: 10 by default, 25 at most. */
  readonly limit?: number
}

/** Conversations found by meaning, the best first. */
export interface AgentThreadSearchResult {
  readonly conversations: readonly AgentThreadSearchConversation[]
  /**
   * Set when there were more turns than one search reads: only those from this instant on were
   * searched. Searching again with `until` set to it goes further back.
   */
  readonly searchedFrom?: Date
}

export interface AgentThreadSearchConversation {
  readonly thread: {
    readonly id: string
    readonly title?: string
    readonly createdAt: Date
    readonly lastMessageAt?: Date
    /** Someone was added to it. */
    readonly shared: boolean
  }
  /** Its best turn's score. */
  readonly score: number
  /** Its best turns, the best first. */
  readonly turns: readonly AgentThreadSearchTurn[]
}

/** A turn found: what a person asked, and what the Agent did of it. */
export interface AgentThreadSearchTurn {
  /** The person's message that opens it. */
  readonly messageId: string
  readonly firstSeq: number
  readonly lastSeq: number
  /** When that message was written. */
  readonly at: Date
  /** Cosine similarity to the search, from -1 to 1. */
  readonly score: number
  /** The start of what was asked and answered. */
  readonly excerpt: string
  /** What the turn published, under its title now. */
  readonly artifacts: readonly { readonly id: string; readonly title: string }[]
}

/**
 * Search the caller's earlier conversations by meaning: those they own and those they were added to,
 * never one they only observe, nor a sub-agent's.
 *
 * Called from a run, the run decides what it reads, never its input: never the conversation it
 * works for, and from a shared conversation none of its requester's private ones. A workflow's
 * agent node reads none. The query's embedding is billed to the caller's execution.
 */
export async function searchAgentThreads(
  runtime: SixbRuntimeContext,
  caller: {
    readonly execution: ExecutionContext
    /** Whose conversations the caller reads, as the access rule decides it. */
    readonly scope: ReturnType<AgentThreadAccessRule["scope"]>
  },
  input: SearchAgentThreadsInput
): Promise<AgentThreadSearchResult> {
  const query = searchQuery(input)

  // A workflow's agent node acts as its own account, which names it.
  const { executor } = caller.execution
  if (executor.type === "agent" && executor.actorId !== undefined) throw workflowNodeRefused()
  if (caller.scope === "none") return { conversations: [] }

  const agents = runtime.storage.agents
  if (!agents) {
    throw new AgentRequestError("storage_unavailable", "[Sixb] Agent storage is not configured.")
  }
  const reach = await runReach(
    { agents, executions: runtime.storage.executions },
    runtime.projectId,
    caller.execution
  )

  const model = runtime.embeddingModels?.list()[0]?.model
  if (!model) {
    throw unavailable(
      "the project has no embedding model. Register one in models.embedding; its conversations are then indexed in the background."
    )
  }
  if (!(await agents.turnVectors.searchAvailable())) throw storageCannotSearch()

  const vector = await embedQuery(model, query.text)

  let result: SearchAgentTurnVectorsResult
  try {
    result = await agents.turnVectors.search({
      projectId: runtime.projectId,
      configuration: agentTurnVectorConfiguration(model),
      vector,
      ...(caller.scope === "every" ? {} : { principal: caller.scope.reader }),
      ...reach,
      ...(query.since ? { since: query.since } : {}),
      ...(query.until ? { until: query.until } : {}),
      // Enough turns to fill `limit` conversations, as each keeps at most this many.
      k: query.limit * TURNS_PER_CONVERSATION,
      perThread: TURNS_PER_CONVERSATION,
      candidates: vectorSearchCandidateLimit(vector.length),
    })
  } catch (error) {
    if (error instanceof ObjectQueryExecutionError && error.code === "vector_extension_missing") {
      throw storageCannotSearch()
    }
    throw error
  }

  // Hits come the best first, so each conversation's first is its best.
  const byThread = new Map<string, AgentTurnSearchHit[]>()
  for (const hit of result.hits) {
    const hits = byThread.get(hit.threadId) ?? []
    hits.push(hit)
    byThread.set(hit.threadId, hits)
  }
  const threadIds = [...byThread.keys()].slice(0, query.limit)

  const participants = await agents.threads.listParticipants({
    projectId: runtime.projectId,
    threadIds,
  })
  const shared = new Set(participants.map((participant) => participant.threadId))

  const artifactAccess = runtime.storage.artifacts
    ? createRuntimeArtifactAccessRule(runtime)
    : undefined
  const conversations: AgentThreadSearchConversation[] = []
  for (const threadId of threadIds) {
    // Deleted since it was found.
    const thread = await agents.threads.getById({ projectId: runtime.projectId, id: threadId })
    if (!thread) continue

    const hits = byThread.get(threadId)!
    const turns: AgentThreadSearchTurn[] = []
    for (const hit of hits) {
      turns.push({
        messageId: hit.messageId,
        firstSeq: hit.firstSeq,
        lastSeq: hit.lastSeq,
        at: hit.turnAt,
        score: hit.score,
        excerpt: excerptOf(hit.text),
        artifacts: artifactAccess
          ? await turnArtifacts(runtime, agents, artifactAccess, thread, hit)
          : [],
      })
    }

    conversations.push({
      thread: {
        id: thread.id,
        ...(thread.title ? { title: thread.title } : {}),
        createdAt: thread.createdAt,
        ...(thread.lastMessageAt ? { lastMessageAt: thread.lastMessageAt } : {}),
        shared: shared.has(thread.id),
      },
      score: hits[0]!.score,
      turns,
    })
  }

  return {
    conversations,
    ...(result.searchedFrom ? { searchedFrom: result.searchedFrom } : {}),
  }
}

interface SearchQuery {
  readonly text: string
  readonly since?: Date
  readonly until?: Date
  readonly limit: number
}

function searchQuery(input: SearchAgentThreadsInput): SearchQuery {
  if (!input || typeof input !== "object") invalid("Pass { text } to search.")

  const text = typeof input.text === "string" ? input.text.trim() : ""
  if (!text) invalid("Say what to look for in 'text'.")
  if (text.length > TURN_CHUNK_MAX_CHARS) {
    invalid(`'text' is longer than ${TURN_CHUNK_MAX_CHARS} characters: say it in fewer words.`)
  }

  for (const [name, value] of [
    ["since", input.since],
    ["until", input.until],
  ] as const) {
    if (value !== undefined && !(value instanceof Date && Number.isFinite(value.getTime()))) {
      invalid(`'${name}' must be a valid date.`)
    }
  }
  if (input.since && input.until && input.since > input.until) {
    invalid("'since' must not be after 'until'.")
  }

  const limit = input.limit ?? DEFAULT_LIMIT
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_AGENT_THREAD_SEARCH_LIMIT) {
    invalid(`'limit' must be a whole number from 1 to ${MAX_AGENT_THREAD_SEARCH_LIMIT}.`)
  }

  return {
    text,
    ...(input.since ? { since: input.since } : {}),
    ...(input.until ? { until: input.until } : {}),
    limit,
  }
}

/** What a search reaches: which of the caller's conversations, and the one it leaves out. */
interface SearchReach {
  readonly scope: AgentTurnSearchScope
  readonly excludeThreadId?: string
}

/**
 * What a run's search reads, from the run itself: never the conversation it works for, and from a
 * shared one only conversations someone else reads too, so nothing private of its requester's
 * reaches the people it shares. A person calling directly reads all of theirs.
 */
async function runReach(
  storage: AgentRunConversationStorage,
  projectId: string,
  execution: ExecutionContext
): Promise<SearchReach> {
  if (execution.executor.type !== "agent") return { scope: "all" }

  const run = await storage.agents.runs.getById({ projectId, id: execution.executor.runId })
  if (!run) throw workflowNodeRefused()

  const conversation = await agentRunConversation(storage, run)
  return {
    scope: conversation.shared ? "shared" : "all",
    excludeThreadId: conversation.threadId,
  }
}

/**
 * Whether a run may read another conversation than its own thread: one its search could find, a
 * conversation of its requester's that is not the one it works for, and from a shared conversation
 * one someone else reads too. `thread` is what the requester reads, by the access rule.
 */
export async function agentRunReadsConversation(
  storage: AgentRunConversationStorage,
  run: AgentRunRecord,
  thread: Pick<AgentThreadView, "id" | "kind" | "participants">
): Promise<boolean> {
  if (thread.kind !== "conversation") return false

  const conversation = await agentRunConversation(storage, run)
  if (thread.id === conversation.threadId) return false
  return !conversation.shared || thread.participants.length > 0
}

function workflowNodeRefused(): AgentRequestError {
  return new AgentRequestError(
    "search_not_allowed",
    "[Sixb] A workflow agent node cannot search conversations: it works for none."
  )
}

async function embedQuery(model: EmbeddingModel, text: string): Promise<readonly number[]> {
  const signal = AbortSignal.timeout(QUERY_EMBEDDING_TIMEOUT_MS)
  const result = await model.embed({ texts: [text], purpose: "query", signal })
  signal.throwIfAborted()

  const [vector] = Array.isArray(result?.vectors) ? result.vectors : []
  try {
    if (!vector || result.vectors.length !== 1) throw new Error("not one vector")
    return normalizeVector(vector, model.definition.dimensions)
  } catch (cause) {
    throw createSixbError(
      "vector.response_invalid",
      `[Sixb] The embedding model '${model.modelId}' did not return one usable vector for the search.`,
      { cause }
    )
  }
}

/**
 * The artifacts a turn published that the caller may open, from the runs that answered it: the one
 * its message started, and those that resumed it. A turn's runs start after it opens, so the
 * first runs from then on are read, and matched to the person's messages of the turn. Each read is
 * bounded, so a long turn may show fewer.
 */
async function turnArtifacts(
  runtime: SixbRuntimeContext,
  agents: AgentStorage,
  access: ArtifactAccessRule,
  thread: AgentThreadRecord,
  hit: AgentTurnSearchHit
): Promise<AgentThreadSearchTurn["artifacts"]> {
  const artifacts = runtime.storage.artifacts
  if (!artifacts) return []
  const { projectId } = runtime

  // Only the person's messages: an answer's steps hold every tool output.
  const { messages } = await agents.messages.list({
    projectId,
    threadId: thread.id,
    afterSeq: hit.firstSeq - 1,
    roles: ["user"],
    order: "asc",
    limit: TURN_MESSAGES_READ,
  })
  const triggers = new Set(
    messages.filter((message) => message.seq <= hit.lastSeq).map((message) => message.id)
  )

  const { runs } = await agents.runs.list({
    projectId,
    threadId: thread.id,
    kinds: ["conversation"],
    startedAfter: hit.turnAt,
    order: "asc",
    limit: TURN_RUNS_READ,
  })

  const published: { id: string; title: string }[] = []
  const seen = new Set<string>()
  for (const run of runs) {
    if (run.kind !== "conversation" || !triggers.has(run.triggerMessageId)) continue

    for (const write of await artifacts.listTurnWrites({ projectId, turnRunId: run.id })) {
      if (seen.has(write.artifactId)) continue
      seen.add(write.artifactId)

      const artifact = await artifacts.get({ projectId, id: write.artifactId })
      if (!artifact || (await access.accessTo(artifact)) === "none") continue

      published.push({ id: artifact.id, title: artifact.title })
      if (published.length === TURN_ARTIFACTS_SHOWN) return published
    }
  }
  return published
}

/** The start of a turn's text, cut at a word, never inside a character. */
function excerptOf(text: string): string {
  const trimmed = text.trim()
  if (trimmed.length <= EXCERPT_MAX_CHARS) return trimmed

  let cut = trimmed.slice(0, EXCERPT_MAX_CHARS)
  const space = cut.search(/\s\S*$/)
  if (space > EXCERPT_MAX_CHARS / 2) cut = cut.slice(0, space)
  if (/[\uD800-\uDBFF]$/.test(cut)) cut = cut.slice(0, -1)

  return `${cut.trimEnd()}…`
}

function unavailable(reason: string) {
  return createSixbError(
    "agent.search_unavailable",
    `[Sixb] Earlier conversations cannot be searched: ${reason}`
  )
}

function storageCannotSearch() {
  return unavailable(
    "storage cannot search vectors. Install pgvector in PostgreSQL's public schema (CREATE EXTENSION vector WITH SCHEMA public), or use a SQLite that loads sqlite-vec."
  )
}

function invalid(message: string): never {
  throw new AgentRequestError("invalid_search", `[Sixb] ${message}`)
}
