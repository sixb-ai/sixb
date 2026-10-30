import type { LanguageModelRequest } from "../models/language-model"
import type { AgentRunRecord } from "../storage/agents"
import { AgentExecutionLostError, AgentRunRefusedError } from "./run-fence"
import {
  type AgentRunSession,
  type AgentRunSessionHost,
  claimAgentRun,
  openAgentRunSession,
} from "./run-session"
import {
  decodeWireValue,
  encodeWireError,
  encodeWireValue,
  parseAgentRunSessionPath,
  wireErrorStatus,
} from "./run-session-wire"
import { agentRunTokenRunId, createAgentRunToken, isValidAgentRunToken } from "./run-token"

// The server side of a session a runner reaches over HTTP. Each request names the run and carries
// its run token, issued under the run's current execution: the request opens the run's session,
// runs one operation of it, and closes it. Every operation is the in-process session's own, so
// what it checks, fences and records is the same wherever the runner is.

type Operation = (
  session: AgentRunSession,
  args: readonly unknown[],
  signal: AbortSignal
) => unknown

/** The session's operations a runner calls, by name; nothing else is reachable. */
const OPERATIONS: Readonly<Record<string, Operation>> = {
  plan: (session) => session.plan(),
  memory: (session, [input]) => session.memory(input as { asOf: Date }),
  context: (session) => session.context(),
  checkpoint: (session, [input]) =>
    session.checkpoint(input as Parameters<AgentRunSession["checkpoint"]>[0]),
  finish: (session, [outcome, messages]) =>
    finish(
      session,
      outcome as Parameters<AgentRunSession["finish"]>[0],
      ownMessages(session.run, messages as Parameters<AgentRunSession["finish"]>[1])
    ),
  assertOwned: (session) => session.assertOwned(),
  renewLease: (session, [leaseExpiresAt]) => renew(session, capLease(leaseExpiresAt as string)),
  "heldCalls.holdsRun": (session) => session.heldCalls.holdsRun(),
  "heldCalls.pausesAfterStep": (session) => session.heldCalls.pausesAfterStep(),
  "children.get": (session, [runId]) => session.children.get(runId as string),
  "children.getMany": (session, [runIds]) => session.children.getMany(runIds as string[]),
  "children.inConversation": (session, [input]) =>
    session.children.inConversation(
      input as Parameters<AgentRunSession["children"]["inConversation"]>[0]
    ),
  "children.threadRuns": (session, [threadId]) => session.children.threadRuns(threadId as string),
  "children.approvals": (session, [runId]) => session.children.approvals(runId as string),
  "children.holdsRun": (session, [runId]) => session.children.holdsRun(runId as string),
  "children.awaitingApproval": (session, [runIds]) =>
    session.children.awaitingApproval(runIds as string[]),
  "children.activeCount": (session) => session.children.activeCount(),
  "children.spawn": (session, [draft]) =>
    session.children.spawn(draft as Parameters<AgentRunSession["children"]["spawn"]>[0]),
  "children.clearAttempt": (session, [input]) =>
    session.children.clearAttempt(
      input as Parameters<AgentRunSession["children"]["clearAttempt"]>[0]
    ),
  "threads.message": (session, [messageId]) => session.threads.message(messageId as string),
  "threads.messages": (session, [input]) =>
    session.threads.messages(input as Parameters<AgentRunSession["threads"]["messages"]>[0]),
  "workspace.transition": (session, [input]) =>
    session.workspace.transition(
      input as Parameters<AgentRunSession["workspace"]["transition"]>[0]
    ),
  "artifacts.list": (session, [input]) =>
    session.artifacts.list(input as Parameters<AgentRunSession["artifacts"]["list"]>[0]),
  "artifacts.getVersion": (session, args) =>
    session.artifacts.getVersion(
      ...(args as Parameters<AgentRunSession["artifacts"]["getVersion"]>)
    ),
  "artifacts.listVersions": (session, args) =>
    session.artifacts.listVersions(
      ...(args as Parameters<AgentRunSession["artifacts"]["listVersions"]>)
    ),
  "artifacts.query": (session, args) =>
    session.artifacts.query(...(args as Parameters<AgentRunSession["artifacts"]["query"]>)),
  "artifacts.updatable": (session, [artifactId]) =>
    session.artifacts.updatable(artifactId as string),
  "artifacts.publish": (session, [input]) =>
    session.artifacts.publish(input as Parameters<AgentRunSession["artifacts"]["publish"]>[0]),
  callTool: (session, [call, options], signal) =>
    session.callTool(call as Parameters<AgentRunSession["callTool"]>[0], {
      ...((options ?? {}) as { maxFileBytes?: number }),
      signal,
    }),
  "models.describe": async (session, [ref]) => {
    const model = await session.models.language(
      ref as Parameters<AgentRunSession["models"]["language"]>[0]
    )
    const { providerId, modelId, definition, rateCard, defaultReasoning, maxOutputTokens } = model
    return { providerId, modelId, definition, rateCard, defaultReasoning, maxOutputTokens }
  },
  "files.stat": (session, [blobId]) => session.files.stat(blobId as string),
}

/**
 * Answer a request a runner sends its run's session. Returns null for a path that is none of the
 * session's, for the host to route as it would.
 */
export async function serveAgentRunSession(
  host: AgentRunSessionHost,
  request: Request
): Promise<Response | null> {
  const target = parseAgentRunSessionPath(new URL(request.url).pathname)
  if (!target) return null

  const admitted = await admitRunner(host, request, target.runId)
  if (admitted instanceof Response) return admitted
  // A child's session hears its parent's cancel too, as the runner's own claim does.
  const session = await openAgentRunSession(
    host,
    admitted,
    admitted.kind === "subagent" ? [admitted.parentRunId] : []
  )
  let streaming = false
  try {
    const { operation } = target
    if (operation === "models.stream") {
      streaming = true
      return await streamModelCall(session, request)
    }
    if (operation === "events") return await publishEvents(session, request)
    if (operation === "files.put") return await putFile(session, request)
    if (operation === "files.open") return await openFile(session, request)
    if (operation === "children.claim") return await claimChild(host, session, request)

    const run = OPERATIONS[operation]
    if (!run || request.method !== "POST") {
      return json(
        { error: { kind: "Error", message: `[Sixb] No session operation '${operation}'.` } },
        404
      )
    }
    const { args } = decodeWireValue(await request.text()) as { args?: readonly unknown[] }
    return json({ result: await run(session, args ?? [], request.signal) })
  } catch (error) {
    const wire = encodeWireError(error)
    return json({ error: wire }, wireErrorStatus(wire))
  } finally {
    if (!streaming) await session.close()
  }
}

/**
 * Claim a queued run for a runner that reaches it over HTTP: the caller decides who may. Returns
 * the claimed run and the run token its runner sends with every session request, or null when the
 * run ended or another runner holds it.
 */
export async function claimAgentRunForRunner(
  host: AgentRunSessionHost,
  input: { readonly run: AgentRunRecord; readonly leaseExpiresAt: string }
): Promise<{ readonly run: AgentRunRecord; readonly runToken: string } | null> {
  const session = await claimAgentRun(host, {
    run: input.run,
    leaseExpiresAt: capLease(input.leaseExpiresAt),
    ...(input.run.kind === "subagent" ? { cancelWith: [input.run.parentRunId] } : {}),
  })
  if (!session) return null
  await session.close()
  return {
    run: session.run,
    runToken: createAgentRunToken({
      projectId: host.projectId,
      runId: session.run.id,
      executionToken: session.executionToken,
    }),
  }
}

/**
 * The furthest ahead a runner over HTTP holds its run: it renews well before, and one that stops
 * renewing lets the run go within this, for the repair pass to end it.
 */
const MAX_RUNNER_LEASE_MS = 2 * 60_000

function capLease(leaseExpiresAt: string): string {
  const latest = Date.now() + MAX_RUNNER_LEASE_MS
  const requested = new Date(leaseExpiresAt).getTime()
  return new Date(Number.isFinite(requested) ? Math.min(requested, latest) : latest).toISOString()
}

/**
 * A runner runs its turn's children itself, so it claims them with the turn's token: only a child
 * of that turn, which the turn spawned.
 */
async function claimChild(
  host: AgentRunSessionHost,
  session: AgentRunSession,
  request: Request
): Promise<Response> {
  const { args } = decodeWireValue(await request.text()) as { args?: readonly unknown[] }
  const [childRunId, leaseExpiresAt] = (args ?? []) as [string, string]
  const child = await session.children.get(childRunId)
  if (child?.kind !== "subagent" || child.parentRunId !== session.run.id) {
    const wire = encodeWireError(
      new AgentRunRefusedError(
        `[Sixb] Agent run '${session.run.id}' claims only its own children, not '${childRunId}'.`
      )
    )
    return json({ error: wire }, wireErrorStatus(wire))
  }
  return json({ result: await claimAgentRunForRunner(host, { run: child, leaseExpiresAt }) })
}

/** The run a request's token holds now: the run it names, still running under that execution. */
async function admitRunner(
  host: AgentRunSessionHost,
  request: Request,
  runId: string
): Promise<AgentRunRecord | Response> {
  const token = request.headers.get("authorization")?.match(/^Bearer\s+(\S+)$/i)?.[1]
  if (!token || agentRunTokenRunId(token) !== runId) {
    return json(
      { error: { kind: "Error", message: "[Sixb] A run's session takes that run's token." } },
      401
    )
  }
  const run = await host.storage.agents.runs.getById({ projectId: host.projectId, id: runId })
  const executionToken = run?.execution?.token
  if (
    !run ||
    run.status !== "running" ||
    !executionToken ||
    !isValidAgentRunToken({ projectId: host.projectId, runId, executionToken, token })
  ) {
    // Its execution ended or moved to another runner: what the runner reads as lost ownership.
    const wire = encodeWireError(new AgentExecutionLostError(runId))
    return json({ error: wire }, wireErrorStatus(wire))
  }
  return run
}

/**
 * Renew the lease, and say whether the run should stop: a cancel recorded on it, or on the run it
 * stops with, which a runner over HTTP hears only here.
 */
async function renew(
  session: AgentRunSession,
  leaseExpiresAt: string
): Promise<{ readonly cancelled: boolean }> {
  await session.renewLease(leaseExpiresAt)
  return { cancelled: session.cancelled.aborted }
}

/**
 * End the run, and say so live: once it ended, its runner's token no longer reaches its session,
 * so the server that recorded the end announces it, its answer first.
 */
async function finish(
  session: AgentRunSession,
  outcome: Parameters<AgentRunSession["finish"]>[0],
  messages: Parameters<AgentRunSession["finish"]>[1]
): Promise<AgentRunRecord> {
  const finished = await session.finish(outcome, messages)
  const answer = [...(messages ?? [])].reverse().find((message) => message.role === "assistant")
  if (finished.kind === "conversation" && answer) {
    await session.events.publishMessageFinalized({ run: finished, messageId: answer.id })
  }
  await session.events.publishRunFinished(finished)
  return finished
}

/**
 * A runner's work, as its run's: in its run's thread, and authored by no one. Turns and children
 * never name an author: only a workflow step, which runs in the cloud, writes as its agent.
 */
function ownMessages(
  run: AgentRunRecord,
  messages: Parameters<AgentRunSession["finish"]>[1]
): Parameters<AgentRunSession["finish"]>[1] {
  return messages?.map(({ authorPrincipal: _author, ...message }) => ({
    ...message,
    projectId: run.projectId,
    threadId: run.threadId,
    runId: run.id,
  }))
}

/** One model call, its events streamed back as lines of JSON as the provider sends them. */
async function streamModelCall(session: AgentRunSession, request: Request): Promise<Response> {
  const { ref, call } = decodeWireValue(await request.text()) as {
    ref: Parameters<AgentRunSession["models"]["language"]>[0]
    call: Omit<LanguageModelRequest, "signal">
  }
  const model = await session.models.language(ref)
  const opened = await model.stream({ ...call, signal: request.signal })
  const encoder = new TextEncoder()
  const iterator = opened.events[Symbol.asyncIterator]()
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await iterator.next()
        if (next.done) {
          controller.close()
          await session.close()
          return
        }
        controller.enqueue(encoder.encode(`${encodeWireValue({ event: next.value })}\n`))
      } catch (error) {
        controller.enqueue(
          encoder.encode(`${encodeWireValue({ error: encodeWireError(error) })}\n`)
        )
        controller.close()
        await session.close()
      }
    },
    async cancel() {
      // The runner let the call go: the model reports it, unfinished.
      await iterator.return?.()
      await session.close()
    },
  })
  return new Response(body, { headers: { "content-type": "application/x-ndjson" } })
}

/** Live records, in the order the runner sent them. Best effort, as in process. */
async function publishEvents(session: AgentRunSession, request: Request): Promise<Response> {
  const { events } = decodeWireValue(await request.text()) as {
    events: readonly { readonly method: string; readonly input: unknown }[]
  }
  const sink = session.events as unknown as Record<string, (input: unknown) => Promise<void>>
  for (const { method, input } of events) {
    if (!EVENT_METHODS.has(method)) continue
    // A record about another run is not this runner's to publish.
    if (!aboutRun(session.run, method, input)) continue
    await sink[method]?.(input)
  }
  return json({ result: null })
}

const EVENT_METHODS = new Set([
  "publishStarted",
  "publishCompactionStarted",
  "publishCompactionCompleted",
  "publishCompactionFailed",
  "publishUiChunk",
  "publishMessageFinalized",
  "publishRunFinished",
])

function aboutRun(run: AgentRunRecord, method: string, input: unknown): boolean {
  const named =
    method === "publishStarted" || method === "publishRunFinished"
      ? (input as AgentRunRecord | undefined)
      : (input as { readonly run?: AgentRunRecord } | undefined)?.run
  return named?.id === run.id
}

async function putFile(session: AgentRunSession, request: Request): Promise<Response> {
  const url = new URL(request.url)
  const size = url.searchParams.get("size")
  const fileRef = await session.files.put({
    body: new Uint8Array(await request.arrayBuffer()),
    ...(size === null ? {} : { expectedSizeBytes: Number(size) }),
    ...optionalParam(url, "fileName"),
    ...optionalParam(url, "mediaType"),
    ...optionalParam(url, "logicalPath"),
    signal: request.signal,
  })
  return json({ result: fileRef })
}

/** A file's bytes. Its id is its content's digest: a runner names only files it read of. */
async function openFile(session: AgentRunSession, request: Request): Promise<Response> {
  const blobId = new URL(request.url).searchParams.get("blobId") ?? ""
  return new Response(await session.files.open(blobId), {
    headers: { "content-type": "application/octet-stream" },
  })
}

function optionalParam(url: URL, name: string): Record<string, string> {
  const value = url.searchParams.get(name)
  return value === null ? {} : { [name]: value }
}

function json(body: unknown, status = 200): Response {
  return new Response(encodeWireValue(body), {
    status,
    headers: { "content-type": "application/json" },
  })
}
