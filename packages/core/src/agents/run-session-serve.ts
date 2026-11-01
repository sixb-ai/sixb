import { captureSixbFailure, createSixbError, withFailureMessage } from "../errors/internal"
import type { LanguageModelRequest } from "../models/language-model"
import { AGENT_RUN_FAILURE_CODES, type AgentRunRecord } from "../storage/agents"
import { AGENT_INLINE_IMAGE_LIMITS } from "./inline-images"
import { AgentExecutionLostError, AgentRunRefusedError } from "./run-fence"
import { agentRunLeaseLapsed, endInterruptedAgentRun } from "./run-liveness"
import {
  type AgentRunSession,
  type AgentRunSessionHost,
  claimAgentRun,
  openAgentRunSession,
} from "./run-session"
import {
  AGENT_RUN_STOPPED_HEADER,
  decodeWireValue,
  encodeWireError,
  encodeWireValue,
  parseAgentRunSessionPath,
  wireErrorStatus,
} from "./run-session-wire"
import { agentRunnerTokenRunId, createAgentRunnerToken, isValidAgentRunnerToken } from "./run-token"

// The server side of a session a runner reaches over HTTP. Each request names the run and carries
// its runner token, issued under the run's current execution: the request opens the run's session,
// runs one operation of it, and closes it. Every operation is the in-process session's own, so
// what it checks, fences and records is the same wherever the runner is.
//
// The run token its sandbox's commands call the API with never reaches it: they would finish the
// run, write its messages and call its models as its runner.

/**
 * The most a runner sends its run's session in one request. The largest is a model call: up to
 * `AGENT_INLINE_IMAGE_LIMITS.maxBytes` (16 MiB) of encoded images, and text up to the model's
 * window, which 2,000,000 tokens at about 5 bytes each (OpenAI's tokenizer measures 4.4 to 4.7)
 * bring to 10 MB, doubled for the wire's JSON escaping: about 36 MiB, so 40 MiB. A run's end,
 * which carries the steps it kept, and a file it stores (25 MiB at most) fit within it too.
 */
export const AGENT_RUN_SESSION_BODY_MAX_BYTES =
  AGENT_INLINE_IMAGE_LIMITS.maxBytes + 24 * 1024 * 1024

type Operation = (
  session: AgentRunSession,
  args: readonly unknown[],
  signal: AbortSignal
) => unknown

/**
 * The session's operations a runner calls, by name; nothing else is reachable. Neither
 * `authorization` nor `workspace` is: only a runner in the worker's process binds the project or
 * moves a persistent workspace.
 */
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
      ...((options ?? {}) as { maxFileBytes?: number; contextDirectory?: string }),
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
 *
 * The session reads the body itself, within {@link AGENT_RUN_SESSION_BODY_MAX_BYTES}, once the
 * runner is admitted: a host that caps request bodies for everyone else lifts its cap then, in
 * `admitted`.
 */
export async function serveAgentRunSession(
  host: AgentRunSessionHost,
  request: Request,
  options: { readonly admitted?: () => void } = {}
): Promise<Response | null> {
  const target = parseAgentRunSessionPath(new URL(request.url).pathname)
  if (!target) return null

  const admitted = await admitRunner(host, request, target.runId)
  if (admitted instanceof Response) return admitted
  options.admitted?.()
  if (!(await stopRecorded(host, admitted))) {
    return serveOperation(host, admitted, target.operation, request)
  }

  // Once a Stop is recorded, its runner only ends the run, keeping what it wrote: nothing more
  // runs, writes or bills. Its lease is not renewed either, so the sweep ends a runner that ignores
  // the Stop. Every answer says so, for the runner to stop at once.
  let response: Response
  if (target.operation === "renewLease") {
    response = json({ result: { cancelled: true } })
  } else if (STOPPING_OPERATIONS.has(target.operation)) {
    response = await serveOperation(host, admitted, target.operation, request)
  } else {
    response = stopped(admitted)
  }
  response.headers.set(AGENT_RUN_STOPPED_HEADER, "true")
  return response
}

/**
 * What a stopped run's runner still needs besides `renewLease`: the reads between a model step and
 * its end, which decide whether it pauses and wait for its children, then the end itself.
 */
const STOPPING_OPERATIONS = new Set([
  "heldCalls.holdsRun",
  "heldCalls.pausesAfterStep",
  "children.getMany",
  "children.activeCount",
  "finish",
])

/** One operation of the run's session, in a session opened for it. */
async function serveOperation(
  host: AgentRunSessionHost,
  admitted: AgentRunRecord,
  operation: string,
  request: Request
): Promise<Response> {
  // A child's session hears its parent's cancel too, as the runner's own claim does.
  const session = await openAgentRunSession(
    host,
    admitted,
    admitted.kind === "subagent" ? [admitted.parentRunId] : []
  )
  let streaming = false
  try {
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
    const { args } = decodeWireValue(await readBodyText(request)) as {
      args?: readonly unknown[]
    }
    return json({ result: await run(session, args ?? [], request.signal) })
  } catch (error) {
    // No stream was returned to close the session when it ends.
    streaming = false
    if (error instanceof SessionBodyTooLargeError) return await failTooLarge(session, operation)

    const wire = encodeWireError(error)
    return json({ error: wire }, wireErrorStatus(wire))
  } finally {
    if (!streaming) await session.close()
  }
}

/**
 * Claim a queued run for a runner that reaches it over HTTP: the caller decides who may. Returns
 * the claimed run and the runner token its runner sends with every session request, or null when
 * the run ended or another runner holds it. The run token its commands get comes from the run's
 * execution token, as the worker's does.
 *
 * A running run is never taken over: it already streamed and billed what it did. Once its lease
 * lapsed, it ends interrupted here, as the lapsed-run sweep would end it, and the claim is refused.
 */
export async function claimAgentRunForRunner(
  host: AgentRunSessionHost,
  input: { readonly run: AgentRunRecord; readonly leaseExpiresAt: string }
): Promise<{ readonly run: AgentRunRecord; readonly runnerToken: string } | null> {
  if (input.run.status === "running") {
    const ended =
      agentRunLeaseLapsed(input.run) &&
      (await endInterruptedAgentRun(host, input.run, MAX_RUNNER_LEASE_MS))
    if (!ended) return null

    throw new AgentRunRefusedError(
      input.run.kind === "subagent"
        ? "[Sixb] This child stopped when its runner did; spawn it again with a new key."
        : "[Sixb] This turn stopped when its runner did; send your message again."
    )
  }

  const session = await claimAgentRun(host, {
    run: input.run,
    leaseExpiresAt: capLease(input.leaseExpiresAt),
    ...(input.run.kind === "subagent" ? { cancelWith: [input.run.parentRunId] } : {}),
  })
  if (!session) return null
  await session.close()
  return {
    run: session.run,
    runnerToken: createAgentRunnerToken({
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
 * A runner runs its turn's children itself, so it claims them with the turn's runner token: only a
 * child of that turn, which the turn spawned.
 */
async function claimChild(
  host: AgentRunSessionHost,
  session: AgentRunSession,
  request: Request
): Promise<Response> {
  const { args } = decodeWireValue(await readBodyText(request)) as { args?: readonly unknown[] }
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

/**
 * The run a request's runner token holds now: the run it names, still running under that
 * execution. A run token is refused: it is what the run's own commands hold.
 */
async function admitRunner(
  host: AgentRunSessionHost,
  request: Request,
  runId: string
): Promise<AgentRunRecord | Response> {
  const token = request.headers.get("authorization")?.match(/^Bearer\s+(\S+)$/i)?.[1]
  if (!token || agentRunnerTokenRunId(token) !== runId) {
    return json(
      {
        error: {
          kind: "Error",
          message: "[Sixb] A run's session takes the runner token its claim returned.",
        },
      },
      401
    )
  }
  const run = await host.storage.agents.runs.getById({ projectId: host.projectId, id: runId })
  const executionToken = run?.execution?.token
  if (
    !run ||
    run.status !== "running" ||
    !executionToken ||
    !isValidAgentRunnerToken({ projectId: host.projectId, runId, executionToken, token })
  ) {
    // Its execution ended or moved to another runner: what the runner reads as lost ownership.
    const wire = encodeWireError(new AgentExecutionLostError(runId))
    return json({ error: wire }, wireErrorStatus(wire))
  }
  return run
}

/** Whether a Stop is recorded on the run, or on the turn a child stops with. */
async function stopRecorded(host: AgentRunSessionHost, run: AgentRunRecord): Promise<boolean> {
  if (run.cancelRequestedAt) return true
  if (run.kind !== "subagent") return false

  const parent = await host.storage.agents.runs.getById({
    projectId: host.projectId,
    id: run.parentRunId,
  })
  return Boolean(parent?.cancelRequestedAt)
}

/**
 * What a stopped run's runner hears for anything else: the aborted call a stopped run's session
 * gives in process, which a runner already reads as the run stopping.
 */
function stopped(run: AgentRunRecord): Response {
  const wire = {
    kind: "AbortError",
    message: `[Sixb] Agent run '${run.id}' was stopped: its runner only finishes it now.`,
  }
  return json({ error: wire }, wireErrorStatus(wire))
}

/**
 * Renew the lease, and say whether the run should stop: a cancel recorded on it, or on the run it
 * stops with, since its request was admitted. One recorded before never renews it.
 */
async function renew(
  session: AgentRunSession,
  leaseExpiresAt: string
): Promise<{ readonly cancelled: boolean }> {
  await session.renewLease(leaseExpiresAt)
  return { cancelled: session.cancelled.aborted }
}

/**
 * End the run, and say so live: once it ended, its runner token no longer reaches its session,
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
  const { ref, call } = decodeWireValue(await readBodyText(request)) as {
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
  const { events } = decodeWireValue(await readBodyText(request)) as {
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
    body: await readBody(request),
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

/** A body past {@link AGENT_RUN_SESSION_BODY_MAX_BYTES}, refused while it streams in. */
class SessionBodyTooLargeError extends Error {
  readonly name = "SessionBodyTooLargeError"
}

/** The request's body, read up to {@link AGENT_RUN_SESSION_BODY_MAX_BYTES}. */
async function readBody(request: Request): Promise<Uint8Array<ArrayBuffer>> {
  const declared = Number(request.headers.get("content-length") ?? Number.NaN)
  if (declared > AGENT_RUN_SESSION_BODY_MAX_BYTES) throw new SessionBodyTooLargeError()
  if (!request.body) return new Uint8Array()

  const chunks: Uint8Array[] = []
  let total = 0
  for await (const chunk of request.body) {
    total += chunk.byteLength
    if (total > AGENT_RUN_SESSION_BODY_MAX_BYTES) throw new SessionBodyTooLargeError()

    chunks.push(chunk)
  }

  const body = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    body.set(chunk, offset)
    offset += chunk.byteLength
  }
  return body
}

async function readBodyText(request: Request): Promise<string> {
  return new TextDecoder().decode(await readBody(request))
}

/**
 * Fail the run whose runner sent its session more than it reads: the runner could not record
 * that end itself, as the end it would send carries the same work, and the run would wait for the
 * sweep with no reason given. The runner learns its run is no longer its own.
 */
async function failTooLarge(session: AgentRunSession, operation: string): Promise<Response> {
  const { run } = session
  const megabytes = AGENT_RUN_SESSION_BODY_MAX_BYTES / (1024 * 1024)
  const completedAt = new Date()
  const error = captureSixbFailure(
    withFailureMessage(
      createSixbError(
        "agent.execution_failed",
        `[Sixb] Agent run '${run.id}' sent its session more than ${megabytes} MiB in one request (${operation}).`
      ),
      `The conversation grew past the ${megabytes} MiB a computer run can send at once. Start a new conversation, or ask for less in one message.`
    ),
    {
      allowedCodes: AGENT_RUN_FAILURE_CODES,
      defaultCode: "agent.execution_failed",
      details:
        run.kind === "conversation"
          ? { runId: run.id, threadId: run.threadId }
          : { parentRunId: run.parentRunId, runId: run.id },
      at: completedAt,
    }
  )

  try {
    const ended = await session.finish({ status: "failed", error, completedAt })
    await session.events.publishRunFinished(ended)
  } catch (failure) {
    if (!(failure instanceof AgentExecutionLostError)) throw failure
  }

  const wire = encodeWireError(new AgentExecutionLostError(run.id))
  return json({ error: wire }, wireErrorStatus(wire))
}

function json(body: unknown, status = 200): Response {
  return new Response(encodeWireValue(body), {
    status,
    headers: { "content-type": "application/json" },
  })
}
