import type { FileRef } from "../blob-storage/types"
import type { LanguageModel, LanguageModelStreamEvent } from "../models"
import type {
  AgentRunRecord,
  AgentThreadComputer,
  ConversationAgentRunRecord,
  SubagentRunRecord,
} from "../storage/agents"
import type { StreamSink } from "./run-events"
import { AgentExecutionLostError } from "./run-fence"
import type { AgentRunSession } from "./run-session"
import {
  AGENT_RUN_STOPPED_HEADER,
  agentRunSessionPath,
  decodeWireError,
  decodeWireValue,
  encodeWireValue,
  type WireError,
} from "./run-session-wire"

// A run's session as a runner reaches it over HTTP: the same operations as the in-process session,
// each one request with the runner token its claim returned (see serveAgentRunSession). The runner
// holds no storage, broker or project: a cancel reaches it at its lease renewals, which it makes
// itself. Its sandbox gets the run token instead, which never reaches this session.

/** How live records go up: gathered for this long, then sent together. */
const EVENT_BATCH_MS = 100

export interface HttpAgentRunSessionInput<TRun extends AgentRunRecord> {
  /** The API's origin, such as `https://api.example.com`. */
  readonly apiUrl: string
  /** The runner token its claim returned, which every request carries. */
  readonly runnerToken: string
  /** The run as its claim left it. */
  readonly run: TRun
  /** Sends a request; defaults to `fetch`. */
  readonly fetch?: (request: Request) => Promise<Response>
}

export function createHttpAgentRunSession<TRun extends AgentRunRecord>(
  input: HttpAgentRunSessionInput<TRun>
): AgentRunSession<TRun> {
  const { run } = input
  const executionToken = run.execution?.token
  if (!executionToken) {
    throw new Error(`[Sixb] Agent run '${run.id}' has no execution token, so it was never claimed.`)
  }
  const send = input.fetch ?? ((request: Request) => fetch(request))
  const cancelled = new AbortController()
  // A cancel recorded before the claim: the run stops before it starts.
  if (run.cancelRequestedAt) cancelled.abort()

  const request = async (
    operation: string,
    init: RequestInit & { readonly query?: string } = {}
  ) => {
    const url = new URL(
      `${agentRunSessionPath(run.id, operation)}${init.query ?? ""}`,
      input.apiUrl
    )
    const response = await send(
      new Request(url, {
        ...init,
        headers: { authorization: `Bearer ${input.runnerToken}`, ...(init.headers ?? {}) },
      })
    )

    // The run was stopped: this runner hears it now rather than at its next renewal.
    if (response.headers.has(AGENT_RUN_STOPPED_HEADER)) cancelled.abort()
    return response
  }
  const call = async <T>(
    operation: string,
    args: readonly unknown[] = [],
    signal?: AbortSignal
  ): Promise<T> =>
    result<T>(
      await request(operation, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: encodeWireValue({ args }),
        ...(signal === undefined ? {} : { signal }),
      })
    )

  const models = new Map<string, Promise<LanguageModel>>()
  const sink = batchedEvents(async (batch) => {
    try {
      await result(
        await request("events", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: encodeWireValue({ events: batch }),
        })
      )
    } catch (error) {
      // A stopped run's live records are refused: its end is the record.
      if (cancelled.signal.aborted) return
      console.error(`[Sixb] Live records of agent run '${run.id}' could not be sent.`, error)
    }
  })

  const session: AgentRunSession = {
    run,
    executionToken,
    cancelled: cancelled.signal,
    models: {
      language(ref) {
        const key = `${ref.provider}/${ref.modelId}`
        let model = models.get(key)
        if (!model) {
          model = call<Omit<LanguageModel, "stream">>("models.describe", [ref]).then((described) =>
            httpModel(described, ref, request)
          )
          model.catch(() => models.delete(key))
          models.set(key, model)
        }
        return model
      },
    },
    events: sink.sink,
    heldCalls: {
      holdsRun: () => call("heldCalls.holdsRun"),
      pausesAfterStep: () => call("heldCalls.pausesAfterStep"),
    },
    children: {
      get: (runId) => call("children.get", [runId]),
      getMany: (runIds) => call("children.getMany", [runIds]),
      inConversation: (filter) => call("children.inConversation", [filter]),
      threadRuns: (threadId) => call("children.threadRuns", [threadId]),
      approvals: (runId) => call("children.approvals", [runId]),
      holdsRun: (runId) => call("children.holdsRun", [runId]),
      awaitingApproval: (runIds) => call("children.awaitingApproval", [runIds]),
      activeCount: () => call("children.activeCount"),
      spawn: (draft) => call("children.spawn", [draft]),
      clearAttempt: (attempt) => call("children.clearAttempt", [attempt]),
    },
    async renewLease(leaseExpiresAt) {
      try {
        const renewed = await call<{ readonly cancelled: boolean }>("renewLease", [leaseExpiresAt])
        if (renewed.cancelled) cancelled.abort()
      } catch (error) {
        // Ended or taken over: this runner stops now, as an in-process one does.
        if (error instanceof AgentExecutionLostError) cancelled.abort(error)
        throw error
      }
    },
    async finish(outcome, messages) {
      // What it streamed goes first; the server announces the end it records.
      await sink.flush()
      const finished = await call<AgentRunRecord>("finish", [outcome, messages])
      sink.end()
      return finished
    },
    assertOwned: () => call("assertOwned"),
    plan: () => call("plan"),
    memory: (memory) => call("memory", [memory]),
    context: () => call("context"),
    checkpoint: (checkpoint) => call("checkpoint", [checkpoint]),
    workspace: {
      async transition() {
        throw new Error(
          `[Sixb] Agent run '${run.id}' reaches its project over HTTP: only a runner in the worker moves a persistent workspace.`
        )
      },
    },
    threads: {
      message: (messageId) => call("threads.message", [messageId]),
      messages: (query) => call("threads.messages", [query]),
    },
    callTool: (toolCall, { signal, ...options }) => call("callTool", [toolCall, options], signal),
    artifacts: {
      list: (query) => call("artifacts.list", [query]),
      getVersion: (...args) => call("artifacts.getVersion", args),
      listVersions: (...args) => call("artifacts.listVersions", args),
      query: (...args) => call("artifacts.query", args),
      updatable: (artifactId) => call("artifacts.updatable", [artifactId]),
      publish: (publish) => call("artifacts.publish", [publish]),
    },
    files: {
      async put(file) {
        const body = new Uint8Array(await new Response(file.body as BodyInit).arrayBuffer())
        const query = new URLSearchParams()
        if (file.fileName !== undefined) query.set("fileName", file.fileName)
        if (file.mediaType !== undefined) query.set("mediaType", file.mediaType)
        if (file.logicalPath !== undefined) query.set("logicalPath", file.logicalPath)
        if (file.expectedSizeBytes !== undefined) query.set("size", String(file.expectedSizeBytes))
        return result<FileRef>(
          await request("files.put", {
            method: "POST",
            body,
            query: `?${query}`,
            ...(file.signal === undefined ? {} : { signal: file.signal }),
          })
        )
      },
      async open(blobId) {
        const response = await request("files.open", {
          method: "GET",
          query: `?${new URLSearchParams({ blobId })}`,
        })
        if (!response.ok || !response.body) await result(response)
        return response.body as ReadableStream<Uint8Array>
      },
      stat: (blobId) => call("files.stat", [blobId]),
    },
    authorization() {
      throw new Error(
        `[Sixb] Agent run '${run.id}' reaches its project over HTTP: its runner holds no authority of its own.`
      )
    },
    async close() {
      await sink.flush()
    },
  }
  return session as AgentRunSession<TRun>
}

/** What a claim answers: the claimed run, and the runner token its session's requests carry. */
interface ClaimedRun<TRun extends AgentRunRecord> {
  readonly run: TRun
  readonly runnerToken: string
}

/**
 * Claim a queued conversation turn as its requester, with their signed-in session (`authorization`,
 * such as `Bearer <session token>` from the CLI's sign-in: the route refuses access tokens), and
 * open its session. Null when the run ended or another runner holds it; refused when its runner
 * stopped, which ended it interrupted.
 */
export async function claimAgentRunOverHttp(input: {
  readonly apiUrl: string
  readonly runId: string
  readonly authorization: string
  readonly leaseExpiresAt: string
  /**
   * The computer claiming it, and its folder: a computer's turn runs only there, where its thread
   * runs.
   */
  readonly computer?: AgentThreadComputer
  readonly fetch?: (request: Request) => Promise<Response>
}): Promise<AgentRunSession<ConversationAgentRunRecord> | null> {
  const send = input.fetch ?? ((request: Request) => fetch(request))
  const response = await send(
    new Request(new URL(`/api/agent-runs/${encodeURIComponent(input.runId)}/claim`, input.apiUrl), {
      method: "POST",
      headers: { authorization: input.authorization, "content-type": "application/json" },
      body: encodeWireValue({
        leaseExpiresAt: input.leaseExpiresAt,
        ...(input.computer === undefined ? {} : { computer: input.computer }),
      }),
    })
  )
  const claimed = await result<ClaimedRun<ConversationAgentRunRecord> | null>(response)
  return claimed && createHttpAgentRunSession({ ...input, ...claimed })
}

/**
 * Claim a child of a turn this runner runs, with the turn's runner token: the runner runs its
 * turns' children itself. Null when the child ended or another runner holds it.
 */
export async function claimAgentRunChildOverHttp(
  turn: HttpAgentRunSessionInput<ConversationAgentRunRecord>,
  input: { readonly childRunId: string; readonly leaseExpiresAt: string }
): Promise<AgentRunSession<SubagentRunRecord> | null> {
  const send = turn.fetch ?? ((request: Request) => fetch(request))
  const response = await send(
    new Request(new URL(agentRunSessionPath(turn.run.id, "children.claim"), turn.apiUrl), {
      method: "POST",
      headers: {
        authorization: `Bearer ${turn.runnerToken}`,
        "content-type": "application/json",
      },
      body: encodeWireValue({ args: [input.childRunId, input.leaseExpiresAt] }),
    })
  )
  const claimed = await result<ClaimedRun<SubagentRunRecord> | null>(response)
  return (
    claimed &&
    createHttpAgentRunSession({
      apiUrl: turn.apiUrl,
      ...claimed,
      ...(turn.fetch === undefined ? {} : { fetch: turn.fetch }),
    })
  )
}

/** Read an operation's answer: its result, or the error it crossed as. */
async function result<T>(response: Response): Promise<T> {
  const text = await response.text()
  let body: { readonly result?: unknown; readonly error?: WireError }
  try {
    body = decodeWireValue(text) as typeof body
  } catch {
    throw new Error(`[Sixb] The run session answered ${response.status} without a session body.`)
  }
  if (body.error) throw decodeWireError(body.error)
  return body.result as T
}

/** A model the server serves: its description here, each call admitted and recorded there. */
function httpModel(
  described: Omit<LanguageModel, "stream">,
  ref: Parameters<AgentRunSession["models"]["language"]>[0],
  request: (operation: string, init: RequestInit) => Promise<Response>
): LanguageModel {
  return {
    ...described,
    async stream({ signal, ...call }) {
      const response = await request("models.stream", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: encodeWireValue({ ref, call }),
        signal,
      })
      if (!response.ok || !response.body) await result(response)
      return { events: modelEvents(response.body as ReadableStream<Uint8Array>) }
    },
  }
}

/** The provider's events, as the server streams them: one JSON line each. */
async function* modelEvents(
  body: ReadableStream<Uint8Array>
): AsyncGenerator<LanguageModelStreamEvent> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffered = ""
  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      buffered += decoder.decode(value, { stream: true })
      let newline = buffered.indexOf("\n")
      while (newline >= 0) {
        const line = buffered.slice(0, newline)
        buffered = buffered.slice(newline + 1)
        if (line) {
          const decoded = decodeWireValue(line) as {
            readonly event?: LanguageModelStreamEvent
            readonly error?: WireError
          }
          if (decoded.error) throw decodeWireError(decoded.error)
          if (decoded.event) yield decoded.event
        }
        newline = buffered.indexOf("\n")
      }
    }
  } finally {
    // A reader that stops early closes the request, and the server reports the call unfinished.
    await reader.cancel().catch(() => {})
  }
}

/**
 * A sink that sends its records in batches: each method returns once its record is queued, as
 * live records are best effort. A run's end is sent at once, with what came before it.
 */
function batchedEvents(
  deliver: (batch: readonly { readonly method: string; readonly input: unknown }[]) => Promise<void>
): { readonly sink: StreamSink; flush(): Promise<void>; end(): void } {
  let queued: { readonly method: string; readonly input: unknown }[] = []
  // Once the run ended, its token reaches nothing: the server announced the end.
  let ended = false
  let timer: ReturnType<typeof setTimeout> | undefined
  let sending = Promise.resolve()
  const flush = () => {
    clearTimeout(timer)
    timer = undefined
    const batch = queued
    queued = []
    if (batch.length > 0) sending = sending.then(() => deliver(batch))
    return sending
  }
  const enqueue = (method: string) => async (record: unknown) => {
    if (ended) return
    queued.push({ method, input: record })
    timer ??= setTimeout(() => void flush(), EVENT_BATCH_MS)
  }
  return {
    sink: {
      publishStarted: enqueue("publishStarted"),
      publishCompactionStarted: enqueue("publishCompactionStarted"),
      publishCompactionCompleted: enqueue("publishCompactionCompleted"),
      publishCompactionFailed: enqueue("publishCompactionFailed"),
      publishUiChunk: enqueue("publishUiChunk"),
      publishMessageFinalized: enqueue("publishMessageFinalized"),
      async publishRunFinished(record) {
        await enqueue("publishRunFinished")(record)
        await flush()
      },
    },
    flush,
    end() {
      ended = true
      clearTimeout(timer)
      queued = []
    },
  }
}
