import { createSixbError, isSixbError } from "../../errors/internal"
import { createKernelRuntimeAuthorization } from "../../execution/authorization"
import { ensureExecutionRecord, executionRecordInputFromRuntime } from "../../execution/durable"
import type { ExecutionContext, ExecutionScope } from "../../execution/types"
import type { EmbeddingModel } from "../../models/embedding-model"
import { bindEmbeddingModels } from "../../models/execution/embedding"
import { ModelExecutionSession } from "../../models/execution/session"
import { retryAt } from "../../objects/vectors/indexing-shared"
import { INDEXING_EMBEDDING_TIMEOUT_MS, normalizeVector } from "../../objects/vectors/profile"
import type { SixbHostContext } from "../../runtime/types"
import type {
  AgentMessageRecord,
  AgentStorage,
  AgentThreadIndexProgress,
  AgentTurnVectorInput,
  AgentTurnVectorStore,
} from "../../storage/agents"
import { agentTurnVectorConfiguration } from "./configuration"
import { type AgentTurn, agentTurnChunks, splitAgentTurns } from "./turns"

/** How many conversations behind one repair pass asks to index. */
const REPAIR_LIMIT = 200
const MESSAGE_PAGE_SIZE = 200
/**
 * A conversation that could not be indexed is tried again later and later, never given up on: a
 * provider down for hours catches up once it is back. Each try may bill a call.
 */
export const TURN_INDEXING_BACKOFF_MS = [60_000, 5 * 60_000, 30 * 60_000, 6 * 60 * 60_000] as const
const utf8 = new TextEncoder()

/**
 * Indexing waits until `availableAt`: the project's AI limit resets then, or, with a `cause`, a
 * failure's backoff ends. The thread records it, so nothing asks for it meanwhile.
 */
export class AgentTurnIndexingDeferred extends Error {
  constructor(
    readonly availableAt: string,
    options?: { readonly cause?: unknown }
  ) {
    super(
      options?.cause === undefined
        ? "[Sixb] Indexing the conversation waits for the project's AI limit."
        : "[Sixb] Indexing the conversation failed; it is tried again later.",
      options
    )
  }
}

/** The background work that keeps each conversation's turn vectors current. */
export interface AgentTurnIndexing {
  /** A turn ended in this thread: index what it changed, as soon as a worker can. */
  request(threadId: string): Promise<void>
  /**
   * Ask for every conversation whose index is behind: one a turn's end did not ask for, one
   * indexed with another model, one from before indexing existed.
   */
  repair(): Promise<void>
  /**
   * Index what changed in a thread since its index was written, as the job's `attempt`. The agent
   * worker's turn indexing lane runs it.
   */
  index(threadId: string, attempt: number, signal: AbortSignal): Promise<void>
}

const registry = new WeakMap<object, AgentTurnIndexing>()

export function registerAgentTurnIndexing(host: object, indexing: AgentTurnIndexing): void {
  registry.set(host, indexing)
}

/** Undefined for a host built without one: nothing is indexed there. */
export function getAgentTurnIndexing(host: object): AgentTurnIndexing | undefined {
  return registry.get(host)
}

/**
 * One job id per thread. Asked again with `replace`, a waiting job takes the new ask, and a claimed
 * one keeps its delivery while the ask waits behind it: two workers never index a thread at once.
 */
export function agentTurnIndexJobId(threadId: string): string {
  return `agt_turns_${threadId}`
}

interface IndexingTarget {
  readonly agents: AgentStorage
  readonly store: AgentTurnVectorStore
  readonly model: EmbeddingModel
  readonly configuration: string
}

/** A turn to write, with what it embeds and the vectors already stored for the same text. */
interface PreparedTurn {
  readonly turn: AgentTurn
  readonly texts: readonly string[]
  readonly reused: readonly (readonly number[] | undefined)[]
}

/** The delivery a job's calls are recorded as, and what stops them. */
interface EmbeddingJob {
  readonly attempt: number
  readonly signal: AbortSignal
}

export function createAgentTurnIndexing(runtime: SixbHostContext): AgentTurnIndexing {
  const { projectId } = runtime

  // Search by meaning exists only with a model to embed with and storage that can search.
  const resolveTarget = async (): Promise<IndexingTarget | null> => {
    const model = runtime.embeddingModels?.list()[0]?.model
    const agents = runtime.storage.agents
    if (!model || !agents?.turnVectors) return null
    if (!(await agents.turnVectors.searchAvailable())) return null

    return {
      agents,
      store: agents.turnVectors,
      model,
      configuration: agentTurnVectorConfiguration(model),
    }
  }

  const enqueue = async (threadIds: readonly string[]): Promise<void> => {
    if (threadIds.length === 0) return
    await runtime.queues.agents.enqueue({
      projectId,
      jobs: threadIds.map((threadId) => ({
        id: agentTurnIndexJobId(threadId),
        type: "agent.thread.index.requested" as const,
        payload: { threadId },
        // A job of this id that ran while the turn held the thread did nothing: ask again.
        replace: true,
      })),
    })
  }

  return {
    async request(threadId) {
      const target = await resolveTarget()
      if (!target) return

      const progress = await target.store.progress({
        projectId,
        threadId,
        configuration: target.configuration,
      })
      if (!progress || progress.current || isDeferred(progress)) return

      await enqueue([threadId])
    },

    async repair() {
      const target = await resolveTarget()
      if (!target) return

      // A deferred thread is left out: its job waits for the deferral's end.
      const behind = await target.store.listThreadsToIndex({
        projectId,
        configuration: target.configuration,
        limit: REPAIR_LIMIT,
      })
      await enqueue(behind.map((thread) => thread.threadId))
    },

    async index(threadId, attempt, signal) {
      const target = await resolveTarget()
      if (!target) return
      const { agents, store, configuration } = target

      // A turn holds the thread: its end asks again.
      const thread = await agents.threads.getById({ projectId, id: threadId })
      if (thread?.kind !== "conversation" || thread.activeRunId !== null) return

      const progress = await store.progress({ projectId, threadId, configuration })
      if (!progress || progress.current) return
      if (isDeferred(progress)) {
        throw new AgentTurnIndexingDeferred(progress.deferredUntil!.toISOString())
      }

      try {
        await indexFrom(target, threadId, progress, { attempt, signal })
      } catch (error) {
        if (signal.aborted) throw error

        // Recorded on the thread, so the repair pass and a turn's end leave it alone meanwhile.
        const limited = error instanceof AgentTurnIndexingDeferred
        const until = limited
          ? new Date(error.availableAt)
          : new Date(Date.now() + turnIndexingBackoffMs(progress.failures))
        await store.defer({ projectId, threadId, configuration, until, failed: !limited })

        throw limited ? error : new AgentTurnIndexingDeferred(until.toISOString(), { cause: error })
      }
    },
  }

  /** Writes the thread's turns from where its index stands, until the thread changes under it. */
  async function indexFrom(
    target: IndexingTarget,
    threadId: string,
    progress: AgentThreadIndexProgress,
    job: EmbeddingJob
  ): Promise<void> {
    const { agents, store, configuration } = target

    const messages = await readMessages(agents, projectId, threadId, progress.fromSeq)
    const turns = splitAgentTurns(messages)
    const stored = (await store.list({ projectId, threadId, fromSeq: progress.fromSeq })).filter(
      (vector) => vector.configuration === configuration
    )

    const prepared: PreparedTurn[] = []
    for (const turn of turns) {
      const titles = await publishedTitles(turn.runIds)
      const texts = agentTurnChunks(turn, titles, {
        ...(target.model.batching ? { maxBytes: target.model.batching.maxInputBytes } : {}),
      })
      const reused = texts.map((text, chunk) => {
        const vector = stored.find(
          (candidate) => candidate.messageId === turn.messageId && candidate.chunk === chunk
        )
        return vector?.text === text ? vector.embedding : undefined
      })

      prepared.push({ turn, texts, reused })
    }

    const embedder = createEmbedder(target, threadId, job)
    let fromSeq = progress.fromSeq
    for (const group of writeGroups(prepared, target.model)) {
      const vectors = await embedder.vectorsOf(group)

      const written = await store.write({
        projectId,
        threadId,
        configuration,
        revision: progress.revision,
        fromSeq,
        turns: vectors,
        complete: group.at(-1) === prepared.at(-1),
      })
      // The thread changed while this read it: the job its change asks for starts over.
      if (!written) return

      fromSeq = group.at(-1)!.turn.lastSeq + 1
    }

    if (prepared.length === 0) {
      await store.write({
        projectId,
        threadId,
        configuration,
        revision: progress.revision,
        fromSeq,
        turns: [],
        complete: true,
      })
    }
  }

  /** The titles of what these runs published, each once, in the order they first wrote it. */
  async function publishedTitles(runIds: readonly string[]): Promise<readonly string[]> {
    const artifacts = runtime.storage.artifacts
    if (!artifacts || runIds.length === 0) return []

    const titles: string[] = []
    const seen = new Set<string>()
    for (const turnRunId of runIds) {
      for (const write of await artifacts.listTurnWrites({ projectId, turnRunId })) {
        if (seen.has(write.artifactId)) continue
        seen.add(write.artifactId)

        const artifact = await artifacts.get({ projectId, id: write.artifactId })
        if (artifact?.title.trim()) titles.push(artifact.title.trim())
      }
    }
    return titles
  }

  /**
   * The project's own work, under no one's own limits: indexing runs as the kernel operation
   * `agents.indexTurns`, one execution per thread, which each of its jobs records its calls under.
   */
  async function indexingScope(threadId: string): Promise<ExecutionScope> {
    const operation = { type: "agents.indexTurns", threadId } as const
    const execution: ExecutionContext = {
      id: `exec_turns_${threadId}`,
      projectId,
      executor: { type: "kernel", operation },
      source: { type: "event", eventId: agentTurnIndexJobId(threadId) },
      correlationId: `turns_${threadId}`,
    }
    const authorization = createKernelRuntimeAuthorization({ execution, operation })

    await ensureExecutionRecord(runtime.storage.executions, {
      ...executionRecordInputFromRuntime({ execution, runtimeAuthorization: authorization }),
      requesterGroupIds: [],
    })

    return { execution, authorization }
  }

  /** The model bound to the thread's execution, on the project's budget. */
  async function boundModel(
    target: IndexingTarget,
    threadId: string,
    job: EmbeddingJob
  ): Promise<EmbeddingModel> {
    const scope = await indexingScope(threadId)
    const session = new ModelExecutionSession(
      { ...runtime, runtimeAuthorization: scope.authorization },
      scope.execution
    )
    session.bind({ attempt: job.attempt, signal: job.signal })

    const model = bindEmbeddingModels(runtime.embeddingModels, session)?.getByRef({
      provider: target.model.providerId,
      modelId: target.model.modelId,
    })?.model
    if (!model) {
      throw createSixbError(
        "vector.model_unavailable",
        "[Sixb] Indexing conversations requires the project's first `models.embedding` model."
      )
    }
    return model
  }

  /**
   * Embeds what each group of turns misses. The model is bound on the first call, so a job with
   * nothing new to embed records no execution. A call the project's AI limit refuses defers the
   * thread: the groups written before it keep what was paid for.
   */
  function createEmbedder(target: IndexingTarget, threadId: string, job: EmbeddingJob) {
    let model: Promise<EmbeddingModel> | undefined

    const embed = async (texts: readonly string[]): Promise<readonly (readonly number[])[]> => {
      model ??= boundModel(target, threadId, job)

      let result: Awaited<ReturnType<EmbeddingModel["embed"]>>
      try {
        result = await (await model).embed({
          texts,
          purpose: "document",
          signal: AbortSignal.any([job.signal, AbortSignal.timeout(INDEXING_EMBEDDING_TIMEOUT_MS)]),
        })
      } catch (error) {
        if (
          isSixbError(error) &&
          (error.code === "ai.usage_limit_exceeded" || error.code === "ai.usage_limit_unavailable")
        ) {
          throw new AgentTurnIndexingDeferred(retryAt(error.details))
        }
        throw error
      }

      try {
        if (!Array.isArray(result?.vectors) || result.vectors.length !== texts.length) {
          throw new Error("Unexpected vector count")
        }
        return result.vectors.map((vector) =>
          normalizeVector(vector, target.model.definition.dimensions)
        )
      } catch (cause) {
        throw createSixbError(
          "vector.response_invalid",
          "[Sixb] Invalid embedding batch response.",
          {
            cause,
          }
        )
      }
    }

    return {
      /**
       * The group's turns with their vectors, embedding what is missing across all of them in as
       * few calls as the model's batch limits allow.
       */
      async vectorsOf(group: readonly PreparedTurn[]): Promise<readonly AgentTurnVectorInput[]> {
        const inputs = group.flatMap((entry, index) =>
          missingOf(entry).map(({ text, chunk }) => ({ text, chunk, index }))
        )

        const embedded = new Map<string, readonly number[]>()
        for (const call of inputCalls(inputs, target.model)) {
          const values = await embed(call.map((input) => input.text))
          for (const [position, input] of call.entries()) {
            embedded.set(`${input.index}:${input.chunk}`, values[position]!)
          }
        }

        return group.flatMap((entry, index): AgentTurnVectorInput[] => {
          const { turn, texts, reused } = entry

          return texts.map((text, chunk) => ({
            messageId: turn.messageId,
            chunk,
            firstSeq: turn.firstSeq,
            lastSeq: turn.lastSeq,
            turnAt: turn.turnAt,
            text,
            embedding: reused[chunk] ?? embedded.get(`${index}:${chunk}`)!,
          }))
        })
      },
    }
  }
}

function isDeferred(progress: AgentThreadIndexProgress): boolean {
  return progress.deferredUntil !== undefined && progress.deferredUntil.getTime() > Date.now()
}

function turnIndexingBackoffMs(failures: number): number {
  const index = Math.min(failures, TURN_INDEXING_BACKOFF_MS.length - 1)
  return TURN_INDEXING_BACKOFF_MS[index]!
}

/** What a turn still has to embed: the chunks whose text has no stored vector. */
function missingOf(
  entry: PreparedTurn
): readonly { readonly text: string; readonly chunk: number }[] {
  return entry.texts.flatMap((text, chunk) => (entry.reused[chunk] ? [] : [{ text, chunk }]))
}

/** Every message from `fromSeq` on, in order. */
async function readMessages(
  agents: AgentStorage,
  projectId: string,
  threadId: string,
  fromSeq: number
): Promise<readonly AgentMessageRecord[]> {
  const messages: AgentMessageRecord[] = []
  let afterSeq = fromSeq - 1

  for (;;) {
    const page = await agents.messages.list({
      projectId,
      threadId,
      afterSeq,
      order: "asc",
      limit: MESSAGE_PAGE_SIZE,
    })
    messages.push(...page.messages)
    if (!page.hasMore || page.messages.length === 0) return messages
    afterSeq = page.messages.at(-1)!.seq
  }
}

/**
 * Consecutive turns written together: their missing inputs fit one call, so a limit reached part
 * way keeps what was paid for. A turn with more than one call's inputs is a group of its own,
 * embedded in several. A turn that embeds nothing joins any group. Without batch limits, each turn
 * that embeds something is a group of its own.
 */
function writeGroups(
  prepared: readonly PreparedTurn[],
  model: EmbeddingModel
): readonly (readonly PreparedTurn[])[] {
  const limits = model.batching
  const groups: PreparedTurn[][] = []
  let current: PreparedTurn[] = []
  let inputs = 0
  let bytes = 0

  for (const entry of prepared) {
    const missing = missingOf(entry)
    const size = missing.reduce((sum, { text }) => sum + utf8.encode(text).byteLength, 0)
    const fits =
      missing.length === 0 ||
      inputs === 0 ||
      (limits !== undefined &&
        inputs + missing.length <= limits.maxInputs &&
        bytes + size <= limits.maxTotalInputBytes)

    if (!fits) {
      groups.push(current)
      current = []
      inputs = 0
      bytes = 0
    }

    current.push(entry)
    inputs += missing.length
    bytes += size
  }

  if (current.length > 0) groups.push(current)
  return groups
}

/** Inputs in as many calls as the model's batch limits take; one by one without them. */
function inputCalls<T extends { readonly text: string }>(
  inputs: readonly T[],
  model: EmbeddingModel
): readonly (readonly T[])[] {
  const limits = model.batching
  if (!limits) return inputs.map((input) => [input])

  const calls: T[][] = []
  let current: T[] = []
  let bytes = 0
  for (const input of inputs) {
    const size = utf8.encode(input.text).byteLength
    if (
      current.length > 0 &&
      (current.length >= limits.maxInputs || bytes + size > limits.maxTotalInputBytes)
    ) {
      calls.push(current)
      current = []
      bytes = 0
    }
    current.push(input)
    bytes += size
  }

  if (current.length > 0) calls.push(current)
  return calls
}
