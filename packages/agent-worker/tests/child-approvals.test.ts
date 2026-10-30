import { afterEach, describe, expect, jest, spyOn, test } from "bun:test"
import { join } from "node:path"
import { AGENT_RUNTIME_PROFILE } from "@sixb/cli-core"
import {
  type AgentApprovalCall,
  agent,
  type CommandResult,
  type CreateSandboxOptions,
  can,
  defineAction,
  defineGroup,
  defineObjectType,
  defineRole,
  InMemoryBlobStorage,
  InMemoryBroker,
  InMemoryLakeStorage,
  InMemoryQueues,
  InMemoryStorage,
  prop,
  type RunCommandOptions,
  type Sandbox,
  type SandboxFactory,
  type SandboxFileRecord,
  SixbHost,
} from "@sixb/core"
import {
  createSubagentRunId,
  createSubagentThreadId,
  holdAgentApprovalCall,
} from "@sixb/core/internal/agents"
import { emptyGrantIndex } from "@sixb/core/internal/authorization"
import { bindRequestExecution } from "@sixb/core/internal/request-execution"
import type { LanguageModelRequest, LanguageModelStream } from "@sixb/core/models"
import { SandboxStateUnavailableError } from "@sixb/core/sandboxes"
import type { AgentRunRecord, AgentStorage, SubagentRunRecord } from "@sixb/core/storage"
import { createTestSixb } from "@sixb/core/testing"
import { renderCurrentTime } from "../../agent/src/agent-prompt"
import { FamilyMailbox } from "../../agent/src/family-mailbox"
import { CHILD_WAIT_RECHECK_MS, OTHER_TURN_RECHECK_MS } from "../../agent/src/subagent-tools"
import { testStream, WorkerTestModel } from "../../agent/tests/worker-model-fixture"
import { AgentWorker } from "../src"

// A child's held call pauses the child durably; once its requester decides, the turn that resumes
// continues it as the next run of its thread, and its siblings never stop for it.

const projectId = "agent-child-approvals"
const alice = { type: "user", id: "usr_alice" } as const
const HELD_COMMAND = "sixb actions request mark-paid --subject invoice:INV-2041"
const WRITE_SUMMARY = "write-summary"
/** Breaks the sandbox's listing, so the files a child leaves in out/ cannot be stored. */
const BREAK_LISTING = "break-listing"
/** A command that returns only once `blocking` lets it, whatever stops the run meanwhile. */
const BLOCK = "block"
let blocking: (() => Promise<void>) | undefined
/** Notes a child keeps outside out/: only its workspace keeps them. */
const WRITE_NOTES = "write-notes"
const READ_NOTES = "read-notes"
const NOTES = "INV-2041: approval requested.\n"
/** The parent writes a brief it hands its child, which edits it. */
const WRITE_BRIEF = "write-brief"
const EDIT_BRIEF = "edit-brief"
/** A file the parent hands from its run context, which every run of a workspace starts without. */
const TERMS = ".sixb/agent/attachments/terms.md"
const WRITE_TERMS = "write-terms"

const Invoice = defineObjectType({
  id: "invoice",
  name: "Invoice",
  properties: [prop("id", "string", { primary: true, required: true }), prop("status", "string")],
})

/** How many times the approved call's edits ran: once, by the decision. */
let editsRun = 0

const markPaid = defineAction("mark-paid")
  .on(Invoice)
  .params({})
  .edits(({ objects, subject }) => {
    editsRun += 1
    objects(Invoice).byId(subject.primaryId).update({ status: "paid" })
  })

const agentUsers = defineGroup("agent-users")
const agentRunner = defineRole("agent.runner", {
  grantedTo: [agentUsers],
  grants: [can.run(agent), can.view(Invoice), can.apply(markPaid)],
})

const heldCall: AgentApprovalCall = {
  kind: "action",
  actionId: "mark-paid",
  subject: { kind: "object", objectTypeId: "invoice", primaryId: "INV-2041" },
  params: {},
  actionRunId: "act_mark_paid",
  effect: "ontology",
}

const PAY = { key: "pay", task: "Mark INV-2041 paid." }
const COLLECT = { key: "collect", task: "List the open invoices." }

afterEach(() => {
  editsRun = 0
  blocking = undefined
  jest.useRealTimers()
  jest.restoreAllMocks()
})

/**
 * A sandbox whose `sixb actions request` reaches a stand-in for the agent API gateway, which holds
 * the call by the run's mode, and whose files the worker lists and reads as a sandbox would serve
 * them.
 */
class GatewaySandbox implements Sandbox {
  readonly provider = "test"
  readonly status = "running"
  readonly workingDirectory: string
  readonly files = new Map<string, Uint8Array>()
  /** The name a persistent provider keeps it under. */
  persistedAs: string | undefined
  destroyed = false
  /** Its snapshot fails, as a provider's that could not save it. */
  stopFails = false
  private listingBroken = false

  /** As a firewall adds credentials: the URL itself. */
  credentialedUrl(url: string): string {
    return url
  }

  constructor(
    readonly id: string,
    private readonly host: SixbHost,
    /** What happens once the gateway held a call, before the command returns. */
    private readonly afterHold: (runId: string) => Promise<void>
  ) {
    this.workingDirectory = `/tmp/sixb-child-approvals/${id}`
  }

  has(path: string): boolean {
    return this.files.has(join(this.workingDirectory, path))
  }

  text(path: string): string | undefined {
    const bytes = this.files.get(join(this.workingDirectory, path))
    return bytes && new TextDecoder().decode(bytes)
  }

  async writeFiles(files: readonly SandboxFileRecord[]): Promise<void> {
    for (const file of files) {
      const path = file.path.startsWith("/") ? file.path : join(this.workingDirectory, file.path)
      this.files.set(
        path,
        typeof file.contents === "string"
          ? new TextEncoder().encode(file.contents)
          : new Uint8Array(file.contents)
      )
    }
  }

  async runCommand(
    command: string,
    args: readonly string[] = [],
    options: RunCommandOptions = {}
  ): Promise<CommandResult> {
    const script = args.at(-1) ?? ""
    if (command !== "bash") return ok("")

    if (script.includes("SIXB_BASH_ENV_READY")) return ok("node\t22.0.0\tsixb CLI 1\n")
    if (script === "sixb status") {
      return ok(
        JSON.stringify({
          ok: true,
          profile: AGENT_RUNTIME_PROFILE,
          cli: { version: "1" },
          javascript: { name: "node", version: "22.0.0" },
          project: { id: projectId },
        })
      )
    }
    if (script === HELD_COMMAND) {
      await holdTheCall(this.host, String(options.env?.SIXB_RUN_ID))
      await this.afterHold(String(options.env?.SIXB_RUN_ID))
      // Exit code 4: the call waits.
      return { exitCode: 4, stdout: "", stderr: "", durationMs: 1 }
    }
    if (script === WRITE_SUMMARY) {
      await this.writeFiles([
        { path: "out/summary.md", contents: "# Invoices\n\nINV-2041 open.\n" },
      ])
      return ok("")
    }
    if (script === BLOCK) {
      await blocking?.()
      return ok("")
    }
    if (script === WRITE_NOTES) {
      await this.writeFiles([{ path: "notes/progress.md", contents: NOTES }])
      return ok("")
    }
    // What a workspace runs at its opening and its save: the run context goes.
    if (script.includes("rm -rf -- .sixb/agent")) {
      const runContext = join(this.workingDirectory, ".sixb/agent/")
      for (const path of [...this.files.keys()]) {
        if (path.startsWith(runContext)) this.files.delete(path)
      }
      return ok("")
    }
    if (script === WRITE_TERMS) {
      await this.writeFiles([{ path: TERMS, contents: "Net 30.\n" }])
      return ok("")
    }
    if (script === WRITE_BRIEF || script === EDIT_BRIEF) {
      const brief = script === WRITE_BRIEF ? "Pay INV-2041.\n" : "Pay INV-2041. Requested.\n"
      await this.writeFiles([{ path: "brief.md", contents: brief }])
      return ok("")
    }
    if (script === READ_NOTES) {
      const notes = this.files.get(join(this.workingDirectory, "notes/progress.md"))
      return notes
        ? ok(new TextDecoder().decode(notes))
        : { exitCode: 1, stdout: "", stderr: "notes/progress.md: No such file", durationMs: 1 }
    }
    if (script === BREAK_LISTING) {
      this.listingBroken = true
      return ok("")
    }
    if (script.includes("sixb-resolve-sandbox-path")) {
      const path = Buffer.from(options.env?.SIXB_RESOLVE_PATH_B64 ?? "", "base64").toString("utf-8")
      const kind = this.files.has(path)
        ? "file"
        : [...this.files.keys()].some((file) => file.startsWith(`${path}/`))
          ? "directory"
          : "missing"
      return ok(kind === "missing" ? "missing\n" : `${kind}\n${base64(path)}\n`)
    }
    if (script.includes("sixb-list-sandbox-files")) {
      if (this.listingBroken) {
        return { exitCode: 1, stdout: "", stderr: "disk unavailable", durationMs: 1 }
      }
      const prefix = `${options.env?.SIXB_LIST_DIR}/`
      return ok(
        [...this.files.entries()]
          .filter(([path]) => path.startsWith(prefix))
          .map(([path, bytes]) => `${bytes.byteLength}\t${base64(path.slice(prefix.length))}`)
          .join("\n")
      )
    }
    if (script.includes("sixb-read-sandbox-file")) {
      const encoded = options.env?.SIXB_READ_PATH_B64 ?? ""
      const bytes = this.files.get(Buffer.from(encoded, "base64").toString("utf-8"))
      return bytes
        ? ok(`${bytes.byteLength}\n${Buffer.from(bytes).toString("base64")}`)
        : { exitCode: 2, stdout: "", stderr: "file not found", durationMs: 1 }
    }
    return ok("")
  }

  async stop(): Promise<void> {
    if (this.stopFails) throw new Error("[test] The snapshot failed.")
  }

  async destroy(): Promise<void> {
    this.destroyed = true
  }
}

function ok(stdout: string): CommandResult {
  return { exitCode: 0, stdout, stderr: "", durationMs: 1 }
}

function base64(text: string): string {
  return Buffer.from(text, "utf-8").toString("base64")
}

/** What the gateway does with the call: the run's mode holds it for whoever asked for the turn. */
async function holdTheCall(host: SixbHost, runId: string): Promise<void> {
  const agents = requireAgents(host)
  const run = await agents.runs.getById({ projectId, id: runId })
  if (!run) throw new Error(`Expected run '${runId}'.`)
  const hold = await holdAgentApprovalCall(agents, {
    projectId,
    run,
    requestedBy: alice,
    call: heldCall,
  })
  if (hold.kind !== "held") throw new Error(`Expected the call to be held, got '${hold.kind}'.`)
}

function finish(finishReason: "stop" | "tool-calls") {
  return {
    type: "finish",
    finishReason,
    rawFinishReason: finishReason,
    usage: { inputTokens: 10, outputTokens: 5 },
  } as const
}

function toolCalls(...calls: readonly (readonly [string, string, unknown])[]) {
  return testStream([
    { type: "stream-start", warnings: [] },
    ...calls.map(([toolCallId, toolName, input]) => ({
      type: "tool-call" as const,
      toolCallId,
      toolName,
      input: JSON.stringify(input),
    })),
    finish("tool-calls"),
  ])
}

function answer(text: string) {
  return testStream([
    { type: "stream-start", warnings: [] },
    { type: "text-start", id: "answer" },
    { type: "text-delta", id: "answer", delta: text },
    { type: "text-end", id: "answer" },
    finish("stop"),
  ])
}

type Script = (
  request: LanguageModelRequest,
  call: number
) => LanguageModelStream | Promise<LanguageModelStream>

/**
 * The parent's model and the children's, each scripted by the calls it receives. Children tell
 * themselves apart by their task, and a continuation by its first request's outcome block.
 */
function setup(scripts: {
  readonly parent: Script
  readonly children: Readonly<Record<string, Script>>
  readonly afterHold?: (runId: string) => Promise<void>
  /**
   * A provider that keeps named sandboxes and resumes them, as Vercel's does. `lost` names those
   * whose saved files are gone, as an expired snapshot's.
   */
  readonly persistent?: {
    readonly lost?: (name: string) => boolean
    /** Every snapshot fails. */
    readonly stopFails?: boolean
    /** Creation of a named sandbox waits for it. */
    readonly created?: Promise<void>
  }
}) {
  const storage = new InMemoryStorage()
  const parentRequests: LanguageModelRequest[] = []
  const childRequests = new Map<string, LanguageModelRequest[]>()
  const parentModel = new WorkerTestModel({
    providerId: "parent-provider",
    modelId: "parent-model",
    stream: async (request) => {
      parentRequests.push(request)
      return scripts.parent(request, parentRequests.length)
    },
  })
  const childModel = new WorkerTestModel({
    providerId: "child-provider",
    modelId: "child-model",
    stream: async (request) => {
      const text = modelText(request)
      const task = [PAY, COLLECT].find((child) => text.includes(child.task))
      if (!task) throw new Error("Expected a child's task.")
      const name = text.includes("<sixb_approval id=") ? `${task.key}'` : task.key
      const requests = childRequests.get(name) ?? []
      requests.push(request)
      childRequests.set(name, requests)

      const script = scripts.children[name]
      if (!script) throw new Error(`Unexpected child '${name}'.`)
      return script(request, requests.length)
    },
  })
  const sandboxes: GatewaySandbox[] = []
  const resumed: string[] = []
  const create = async (options?: CreateSandboxOptions) => {
    const sandbox = new GatewaySandbox(
      `sandbox-${sandboxes.length + 1}`,
      host,
      scripts.afterHold ?? (async () => {})
    )
    sandbox.persistedAs = options?.persistence?.name
    sandbox.stopFails = sandbox.persistedAs !== undefined && scripts.persistent?.stopFails === true
    if (sandbox.persistedAs) await scripts.persistent?.created
    sandboxes.push(sandbox)
    return sandbox
  }
  const { persistent } = scripts
  const factory: SandboxFactory = persistent
    ? {
        supportsRequestCredentials: true,
        create,
        resume: async (name) => {
          const kept = sandboxes.find((sandbox) => sandbox.persistedAs === name)
          if (!kept || kept.destroyed || persistent.lost?.(name)) {
            throw new SandboxStateUnavailableError(`[test] '${name}' is gone.`)
          }
          resumed.push(name)
          return kept
        },
      }
    : { supportsRequestCredentials: true, create }
  const host: SixbHost = new SixbHost({
    id: projectId,
    ontology: [Invoice],
    actions: [markPaid],
    groups: [agentUsers],
    roles: [agentRunner],
    broker: new InMemoryBroker(),
    storage,
    lakeStorage: new InMemoryLakeStorage(),
    blobStorage: new InMemoryBlobStorage(),
    queues: new InMemoryQueues(),
    sandboxes: factory,
    models: { language: [parentModel, childModel] },
  })
  const worker = new AgentWorker(host, {
    apiBaseUrl: "http://localhost:3002/api/",
  })
  return {
    host,
    agents: requireAgents(host),
    worker,
    parentRequests,
    childRequests: (name: string) => childRequests.get(name) ?? [],
    sandboxes,
    /** The names a persistent provider resumed, in order. */
    resumed,
  }
}

function spawn(child: typeof PAY) {
  return {
    key: child.key,
    task: child.task,
    model: { provider: "child-provider", modelId: "child-model" },
  }
}

function requireAgents(host: SixbHost): AgentStorage {
  const agents = host.storage.agents
  if (!agents) throw new Error("Expected Agent storage.")
  return agents
}

/** Alice, signed in, as the server binds her requests. */
async function signedIn(host: SixbHost) {
  const auth = host.storage.auth
  if (!auth) throw new Error("Expected auth storage.")
  if (!(await auth.users.getById({ projectId, id: alice.id }))) {
    await auth.users.create({ projectId, id: alice.id, email: "alice@example.com" })
    await auth.groupMemberships.upsert({
      projectId,
      userId: alice.id,
      groupId: agentUsers.id,
      source: "manual",
    })
  }
  const sessionId = `session-${crypto.randomUUID()}`
  await auth.sessions.create({
    projectId,
    id: sessionId,
    userId: alice.id,
    strategyId: "test",
    tokenHash: sessionId,
    createdAt: new Date(),
    expiresAt: new Date(Date.now() + 60 * 60_000),
  })

  return bindRequestExecution(host, {
    request: new Request("http://localhost/test"),
    authorization: {
      type: "principal",
      credential: { type: "session", id: sessionId },
      context: {
        principal: alice,
        sessionId,
        groupIds: [agentUsers.id],
        roleIds: [agentRunner.id],
        grants: { ...emptyGrantIndex(), "run:agent": true },
      },
    },
  })
}

async function seedInvoice(host: SixbHost) {
  await createTestSixb(host).objects.upsert("invoice", { id: "INV-2041", status: "open" })
}

/** One turn of the event loop that fake timers do not hold. */
function realLoopTurn(): Promise<void> {
  const { port1, port2 } = new MessageChannel()
  return new Promise((resolve) => {
    port1.onmessage = () => {
      port1.close()
      port2.close()
      resolve()
    }
    port2.postMessage(null)
  })
}

/** Drive fake time, `wait_agent`'s polling included, until `check` holds. */
async function underFakeTime<T>(
  check: () => T | null | undefined | false | Promise<T | null | undefined | false>,
  label: string
): Promise<T> {
  for (let step = 0; step < 2_000; step += 1) {
    await realLoopTurn()
    const value = await check()
    if (value !== null && value !== undefined && value !== false) return value
    jest.advanceTimersByTime(50)
  }
  throw new Error(`[test] ${label} did not settle under fake time.`)
}

async function settle<T>(promise: Promise<T>, label: string): Promise<T> {
  let outcome: { readonly value: T } | { readonly error: unknown } | undefined
  promise.then(
    (value) => {
      outcome = { value }
    },
    (error: unknown) => {
      outcome = { error }
    }
  )
  const settled = await underFakeTime(() => outcome, label)
  if ("error" in settled) throw settled.error
  return settled.value
}

/**
 * Where a run stands after `ms` of fake time, or once it ended if it ended first: whether a turn
 * that could end now waits instead.
 */
async function standingAfter(agents: AgentStorage, runId: string, ms: number) {
  const until = Date.now() + ms
  return underFakeTime(async () => {
    const run = await agents.runs.getById({ projectId, id: runId })
    return run && (run.status === "succeeded" || run.status === "cancelled" || Date.now() >= until)
      ? run
      : null
  }, `run ${runId} after ${ms}ms`)
}

async function terminal(agents: AgentStorage, runId: string): Promise<AgentRunRecord> {
  return underFakeTime(async () => {
    const run = await agents.runs.getById({ projectId, id: runId })
    return run && run.status !== "queued" && run.status !== "running" ? run : null
  }, `run ${runId} terminal`)
}

async function child(agents: AgentStorage, runId: string): Promise<SubagentRunRecord> {
  const run = await agents.runs.getById({ projectId, id: runId })
  if (run?.kind !== "subagent") throw new Error(`Expected child run '${runId}'.`)
  return run
}

async function threadRuns(agents: AgentStorage, threadId: string) {
  return (await agents.runs.list({ projectId, threadId, order: "asc" })).runs
}

async function childMessages(agents: AgentStorage, threadId: string) {
  return (await agents.messages.list({ projectId, threadId, order: "asc" })).messages
}

function modelText(request: LanguageModelRequest | undefined): string {
  return JSON.stringify(request?.messages ?? [])
}

/** What a tool answered the model, by its call id, from the model's next request. */
function toolOutput(request: LanguageModelRequest | undefined, toolCallId: string): unknown {
  for (const message of request?.messages ?? []) {
    if (message.role !== "tool") continue
    for (const part of message.content) {
      if (part.type !== "tool-result" || part.toolCallId !== toolCallId) continue
      const output = part.output
      if (output.type === "json" || output.type === "error-json") return output.value
      try {
        return JSON.parse(output.value)
      } catch {
        return output.value
      }
    }
  }
  return undefined
}

/** What wait_agent answered in a turn, as the thread keeps it. */
async function storedWait(agents: AgentStorage, threadId: string, toolCallId: string) {
  const { messages } = await agents.messages.list({ projectId, threadId })
  for (const message of messages) {
    for (const part of message.parts) {
      if (part.type !== "tool-call" || part.toolCallId !== toolCallId) continue
      if (part.state !== "output-available") throw new Error(`Expected '${toolCallId}' to answer.`)
      const output = part.output as { readonly content?: readonly { readonly text?: string }[] }
      return JSON.parse(output.content?.[0]?.text ?? "null")
    }
  }
  throw new Error(`Expected the tool call '${toolCallId}'.`)
}

/**
 * Pay waits for approval, so the turn pauses: it spawns the child, waits for it, and reads that
 * its call waits. The child stops at its call by itself.
 */
function pausingParent(next: Script = () => answer("INV-2041 is paid.")): Script {
  return (request, call) => {
    if (call === 1) return toolCalls(["spawn", "spawn_agent", spawn(PAY)])
    if (call === 2) return toolCalls(["wait", "wait_agent", { runIds: [payRunIdOf(request)] }])
    return next(request, call)
  }
}

/** The run id the child spawned under, as spawn_agent answered it. */
function payRunIdOf(request: LanguageModelRequest): string {
  const spawned = toolOutput(request, "spawn") as { readonly runId?: string } | undefined
  if (!spawned?.runId) throw new Error("Expected the spawned child's run id.")
  return spawned.runId
}

/** Request a turn as Alice and run it until it ends. */
async function requestTurn(
  harness: ReturnType<typeof setup>,
  text = "Pay INV-2041 and list the open invoices."
) {
  const alicesSixb = await signedIn(harness.host)
  const { run } = await settle(
    alicesSixb.agent.runs.request({ text, approvalMode: "manual" }),
    "request"
  )
  return { run, paused: await terminal(harness.agents, run.id), alicesSixb }
}

async function decide(
  harness: ReturnType<typeof setup>,
  alicesSixb: Awaited<ReturnType<typeof signedIn>>,
  threadId: string,
  decision: "approve" | "deny"
) {
  const [held] = (await alicesSixb.agent.approvals.list({ threadId })).approvals
  if (!held) throw new Error("Expected the held call.")
  const decided = await settle(alicesSixb.agent.approvals.decide(held.id, { decision }), "decide")
  if (!decided.run) throw new Error("Expected the turn to resume.")
  return { held, resumed: await terminal(harness.agents, decided.run.id) }
}

describe("a child whose call waits for approval", () => {
  // Removal proof: drop `pauseAfterStep` from runSubagent; the child's model is called a second
  // time, as its script answers after the call. The finish check still pauses it.
  test("stops after that step, whatever its model would do next", async () => {
    const harness = setup({
      parent: pausingParent(),
      children: {
        pay: (_request, call) =>
          call === 1
            ? toolCalls(["held", "bash", { command: HELD_COMMAND }])
            : answer("I marked INV-2041 paid."),
      },
    })
    jest.useFakeTimers()
    await harness.worker.start()
    try {
      const { run, paused } = await requestTurn(harness)
      const pay = await child(harness.agents, createSubagentRunId(run.id, PAY.key))

      expect(harness.childRequests("pay")).toHaveLength(1)
      expect(pay).toMatchObject({
        status: "succeeded",
        finishReason: "awaiting_approval",
        result: { text: "" },
      })
      // Its thread keeps its task, then the step that made the call.
      expect(await childMessages(harness.agents, pay.threadId)).toEqual([
        expect.objectContaining({ role: "user", runId: pay.id }),
        expect.objectContaining({
          role: "assistant",
          runId: pay.id,
          parts: expect.arrayContaining([
            expect.objectContaining({ type: "tool-call", toolCallId: "held", toolName: "bash" }),
          ]),
        }),
      ])
      expect(paused).toMatchObject({ status: "succeeded", finishReason: "awaiting_approval" })
      // The parent read that its child waits, not an answer.
      expect(await storedWait(harness.agents, run.threadId, "wait")).toMatchObject({
        results: [
          {
            runId: pay.id,
            status: "awaiting_approval",
            awaitingApproval: [expect.objectContaining({ call: expect.objectContaining({}) })],
          },
        ],
      })
    } finally {
      await settle(harness.worker.stop(), "worker stop")
    }
  })

  // Removal proof: drop the "no child queued or running" condition from turnPausesOnHeldCalls;
  // the parent pauses after the wait that saw Pay wait, and its end cancels Collect.
  test("never stops its siblings: the turn pauses once none of them is at work", async () => {
    let releaseCollect!: () => void
    const collectReleased = new Promise<void>((resolve) => {
      releaseCollect = resolve
    })
    const harness = setup({
      parent: (request, call) => {
        if (call === 1) {
          return toolCalls(
            ["spawn", "spawn_agent", spawn(PAY)],
            ["spawn-collect", "spawn_agent", spawn(COLLECT)]
          )
        }
        if (call === 2) {
          return toolCalls(["wait", "wait_agent", { runIds: [payRunIdOf(request)] }])
        }
        if (call === 3) {
          releaseCollect()
          const collect = toolOutput(harness.parentRequests[1], "spawn-collect") as {
            readonly runId: string
          }
          return toolCalls(["wait-collect", "wait_agent", { runIds: [collect.runId] }])
        }
        return answer("INV-2041 waits for you; three invoices are open.")
      },
      children: {
        pay: () => toolCalls(["held", "bash", { command: HELD_COMMAND }]),
        collect: async () => {
          await collectReleased
          return answer("Three invoices are open.")
        },
      },
    })
    jest.useFakeTimers()
    await harness.worker.start()
    try {
      const { run, paused } = await requestTurn(harness)
      releaseCollect()
      const collect = await terminal(harness.agents, createSubagentRunId(run.id, COLLECT.key))

      expect(paused).toMatchObject({ status: "succeeded", finishReason: "awaiting_approval" })
      expect(collect).toMatchObject({
        status: "succeeded",
        result: { text: "Three invoices are open." },
      })
      // It kept waiting for Collect after Pay paused, and paused after that wait.
      expect(harness.parentRequests).toHaveLength(3)
      expect(toolOutput(harness.parentRequests[2], "wait")).toMatchObject({
        results: [{ status: "awaiting_approval" }],
      })
    } finally {
      releaseCollect()
      await settle(harness.worker.stop(), "worker stop")
    }
  })
})

describe("a turn that ends holding a call", () => {
  // Removal proof: drop `waitForChildren` from runAgentTurn; the turn pauses as soon as it
  // answers, and its end cancels Pay before Pay could pause, with its call.
  test("waits for a child still at work, which pauses on its call instead of being stopped", async () => {
    let markHeld!: () => void
    const held = new Promise<void>((resolve) => {
      markHeld = resolve
    })
    let releasePay!: () => void
    const payReleased = new Promise<void>((resolve) => {
      releasePay = resolve
    })
    const harness = setup({
      parent: async (_request, call) => {
        if (call === 1) return toolCalls(["spawn", "spawn_agent", spawn(PAY)])
        // It answers without waiting, while Pay holds its call and is still at work.
        await held
        return answer("INV-2041 waits for your approval.")
      },
      children: { pay: () => toolCalls(["held", "bash", { command: HELD_COMMAND }]) },
      afterHold: async () => {
        markHeld()
        await payReleased
      },
    })
    jest.useFakeTimers()
    await harness.worker.start()
    try {
      const alicesSixb = await signedIn(harness.host)
      const { run } = await settle(
        alicesSixb.agent.runs.request({ text: "Pay INV-2041.", approvalMode: "manual" }),
        "request"
      )
      await underFakeTime(() => harness.parentRequests.length === 2, "the parent answered")

      expect(await standingAfter(harness.agents, run.id, 2_000)).toMatchObject({
        status: "running",
      })
      releasePay()
      const paused = await terminal(harness.agents, run.id)
      const pay = await child(harness.agents, createSubagentRunId(run.id, PAY.key))

      expect(paused).toMatchObject({ status: "succeeded", finishReason: "awaiting_approval" })
      expect(pay).toMatchObject({ status: "succeeded", finishReason: "awaiting_approval" })
      expect((await harness.agents.approvals.list({ projectId })).approvals).toEqual([
        expect.objectContaining({ callerRunId: pay.id, status: "pending" }),
      ])
    } finally {
      releasePay()
      await settle(harness.worker.stop(), "worker stop")
    }
  })

  // Removal proof: drop the turn's own call from turnPausesOnHeldCalls; the model is called again
  // after the step that made the call, while Collect still works.
  test("pauses after the step of its own call, then waits for its children", async () => {
    let releaseCollect!: () => void
    const collectReleased = new Promise<void>((resolve) => {
      releaseCollect = resolve
    })
    const harness = setup({
      parent: (_request, call) => {
        if (call === 1) return toolCalls(["spawn-collect", "spawn_agent", spawn(COLLECT)])
        if (call === 2) return toolCalls(["held", "bash", { command: HELD_COMMAND }])
        return answer("I kept going after asking.")
      },
      children: {
        collect: async () => {
          await collectReleased
          return answer("Three invoices are open.")
        },
      },
    })
    jest.useFakeTimers()
    await harness.worker.start()
    try {
      const alicesSixb = await signedIn(harness.host)
      const { run } = await settle(
        alicesSixb.agent.runs.request({ text: "Pay INV-2041.", approvalMode: "manual" }),
        "request"
      )
      await underFakeTime(() => harness.parentRequests.length >= 2, "the parent made its call")

      expect(await standingAfter(harness.agents, run.id, 2_000)).toMatchObject({
        status: "running",
      })
      releaseCollect()
      const paused = await terminal(harness.agents, run.id)
      const collect = await child(harness.agents, createSubagentRunId(run.id, COLLECT.key))

      expect(paused).toMatchObject({ status: "succeeded", finishReason: "awaiting_approval" })
      expect(harness.parentRequests).toHaveLength(2)
      expect(collect).toMatchObject({ status: "succeeded" })
    } finally {
      releaseCollect()
      await settle(harness.worker.stop(), "worker stop")
    }
  })
})

describe("a paused child, once its requester decides", () => {
  // Removal proofs: skip `continuePausedChildren` in the worker, and the resumed turn's wait_agent
  // finds no child of its own for Pay's run id; drop `continuedChildId` from wait_agent, and it
  // returns Pay as it paused, awaiting_approval; read only the thread's first message in
  // runSubagent, and the continuation starts from its task alone, without the paused child's
  // request as its prefix.
  test("continues in its thread in the resumed turn, and wait_agent returns its answer", async () => {
    let continuationAtResume: SubagentRunRecord | null = null
    const harness = setup({
      parent: pausingParent(async (request, call) => {
        if (call === 3) {
          // The resumed turn is the one at work: under fake time, both turns may share a
          // `createdAt`, so their order does not tell them apart.
          const { runs } = await harness.agents.runs.list({
            projectId,
            kinds: ["conversation"],
            statuses: ["running"],
          })
          continuationAtResume = await child(
            harness.agents,
            createSubagentRunId(runs[0]?.id ?? "", PAY.key)
          ).catch(() => null)
          return toolCalls(["spawn-again", "spawn_agent", spawn(PAY)])
        }
        if (call === 4) {
          return toolCalls(["wait-again", "wait_agent", { runIds: [payRunIdOf(request)] }])
        }
        return answer("INV-2041 is paid.")
      }),
      children: {
        pay: () => toolCalls(["held", "bash", { command: HELD_COMMAND }]),
        "pay'": () => answer("I marked INV-2041 paid."),
      },
    })
    await seedInvoice(harness.host)
    jest.useFakeTimers()
    await harness.worker.start()
    try {
      const { run, alicesSixb } = await requestTurn(harness)
      const { held, resumed } = await decide(harness, alicesSixb, run.threadId, "approve")
      const pay = await child(harness.agents, createSubagentRunId(run.id, PAY.key))
      const continued = await child(harness.agents, createSubagentRunId(resumed.id, PAY.key))

      expect(resumed).toMatchObject({ status: "succeeded", finishReason: "stop" })
      // Admitted before the resumed turn's model ran, under the same key, in the paused child's
      // thread, which holds both runs' work and the outcome between them.
      expect(continuationAtResume).toMatchObject({ id: continued.id })
      expect(continued).toMatchObject({
        parentRunId: resumed.id,
        spawnKey: PAY.key,
        threadId: pay.threadId,
        status: "succeeded",
        result: { text: "I marked INV-2041 paid." },
      })
      expect(pay.threadId).toBe(createSubagentThreadId(run.id, PAY.key))
      expect(
        (await childMessages(harness.agents, pay.threadId)).map(({ role, runId }) => [role, runId])
      ).toEqual([
        ["user", pay.id],
        ["assistant", pay.id],
        ["user", continued.id],
        ["assistant", continued.id],
      ])

      // Its history is the paused child's last request, then how its call ended, as its own.
      const [last] = harness.childRequests("pay").slice(-1)
      const [first] = harness.childRequests("pay'")
      const lastMessages = last?.messages ?? []
      expect(first?.messages.slice(0, lastMessages.length + 2)).toEqual([
        ...lastMessages,
        expect.objectContaining({ role: "assistant" }),
        expect.objectContaining({ role: "tool" }),
      ])
      const outcome = JSON.stringify(first?.messages.at(-1))
      expect(outcome).toContain(`<sixb_approval id=\\"${held.id}\\" status=\\"approved\\">`)
      expect(outcome).toContain("Your sandbox restarted")
      // It is told when it continues, not only when its task was first given.
      expect(outcome).toContain(renderCurrentTime(continued.createdAt, "UTC"))
      expect(outcome).not.toContain("Your sub-agent")

      // The parent reads which child asked, that it continues, and gets its answer by the old id.
      expect(modelText(harness.parentRequests[2])).toContain(
        "Your sub-agent 'pay' made this request."
      )
      expect(modelText(harness.parentRequests[2])).toContain("It continues with this outcome")
      expect(JSON.stringify(toolOutput(harness.parentRequests[3], "spawn-again"))).toContain(
        "'pay' is the sub-agent that continues after the approval; wait for it with wait_agent."
      )
      expect(toolOutput(harness.parentRequests[4], "wait-again")).toMatchObject({
        results: [{ runId: pay.id, status: "succeeded", text: "I marked INV-2041 paid." }],
      })

      // The decision ran the call; the continuation did not run it again.
      expect(editsRun).toBe(1)
      expect((await harness.host.storage.actionRuns?.list({ projectId }))?.total).toBe(1)
    } finally {
      await settle(harness.worker.stop(), "worker stop")
    }
  })

  // Removal proof: copy the outcomes with their caller in continuePausedChildren; the child reads
  // the parent's text, "Your sub-agent 'pay' made this request", instead of its own.
  test("continues with a denial too, and adapts", async () => {
    const harness = setup({
      parent: pausingParent((request, call) =>
        call === 3
          ? toolCalls(["wait-again", "wait_agent", { runIds: [payRunIdOf(request)] }])
          : answer("INV-2041 stays open.")
      ),
      children: {
        pay: () => toolCalls(["held", "bash", { command: HELD_COMMAND }]),
        "pay'": () => answer("The user denied it; INV-2041 stays open."),
      },
    })
    jest.useFakeTimers()
    await harness.worker.start()
    try {
      const { run, alicesSixb } = await requestTurn(harness)
      const { held, resumed } = await decide(harness, alicesSixb, run.threadId, "deny")
      const [first] = harness.childRequests("pay'")
      const outcome = JSON.stringify(first?.messages.at(-1))

      expect(resumed).toMatchObject({ status: "succeeded" })
      expect(outcome).toContain(`<sixb_approval id=\\"${held.id}\\" status=\\"denied\\">`)
      expect(outcome).toContain("The user denied")
      expect(outcome).not.toContain("Your sub-agent")
      expect(toolOutput(harness.parentRequests[3], "wait-again")).toMatchObject({
        results: [{ status: "succeeded", text: "The user denied it; INV-2041 stays open." }],
      })
      expect(editsRun).toBe(0)
    } finally {
      await settle(harness.worker.stop(), "worker stop")
    }
  })

  // Removal proof: skip the deletion in clearDeadAttempts; the retried turn's continuation reads
  // the failed attempt's outcome and answer in its thread, before its own outcome.
  test("continues again when its resumed turn is retried, without the failed attempt's work", async () => {
    let failed = false
    const harness = setup({
      parent: pausingParent((request, call) => {
        if (call === 3 || call === 5) {
          return toolCalls(["wait-again", "wait_agent", { runIds: [payRunIdOf(request)] }])
        }
        if (call === 4) {
          failed = true
          throw new Error("The parent's model is unavailable.")
        }
        return answer("INV-2041 is paid.")
      }),
      children: {
        pay: () => toolCalls(["held", "bash", { command: HELD_COMMAND }]),
        "pay'": (_request, call) =>
          answer(call === 1 ? "First attempt: marked paid." : "I marked INV-2041 paid."),
      },
    })
    await seedInvoice(harness.host)
    jest.useFakeTimers()
    await harness.worker.start()
    try {
      const { run, alicesSixb } = await requestTurn(harness)
      const { resumed } = await decide(harness, alicesSixb, run.threadId, "approve")
      expect(failed).toBe(true)
      expect(resumed).toMatchObject({ status: "failed" })

      const { run: retried } = await settle(alicesSixb.agent.runs.retry(resumed.id), "retry")
      await terminal(harness.agents, retried.id)
      const pay = await child(harness.agents, createSubagentRunId(run.id, PAY.key))
      const first = await child(harness.agents, createSubagentRunId(resumed.id, PAY.key))
      const again = await child(harness.agents, createSubagentRunId(retried.id, PAY.key))

      expect(again).toMatchObject({
        threadId: pay.threadId,
        status: "succeeded",
        result: { text: "I marked INV-2041 paid." },
      })
      // The failed attempt's continuation is gone from the thread; the retry replays from the pause.
      expect(
        (await childMessages(harness.agents, pay.threadId)).map(({ role, runId }) => [role, runId])
      ).toEqual([
        ["user", pay.id],
        ["assistant", pay.id],
        ["user", again.id],
        ["assistant", again.id],
      ])
      expect(first.status).toBe("succeeded")
      expect(modelText(harness.childRequests("pay'")[1])).not.toContain("First attempt")
      expect(toolOutput(harness.parentRequests.at(-1), "wait-again")).toMatchObject({
        results: [{ runId: pay.id, status: "succeeded", text: "I marked INV-2041 paid." }],
      })
    } finally {
      await settle(harness.worker.stop(), "worker stop")
    }
  })

  // Removal proof: continue every caller in pausedChildrenToContinue, not only those the report
  // marked `continues`; the new message's turn continues Pay with its call set aside.
  test("does not continue when a new message sets its call aside", async () => {
    const harness = setup({
      parent: pausingParent((_request, call) =>
        call === 3 ? answer("Let's look at the open invoices instead.") : answer("Done.")
      ),
      children: {
        pay: () => toolCalls(["held", "bash", { command: HELD_COMMAND }]),
      },
    })
    jest.useFakeTimers()
    await harness.worker.start()
    try {
      const { run, alicesSixb } = await requestTurn(harness)
      const { run: next } = await settle(
        alicesSixb.agent.runs.request({ threadId: run.threadId, text: "Never mind." }),
        "new message"
      )
      await terminal(harness.agents, next.id)

      expect(await threadRuns(harness.agents, run.threadId)).toHaveLength(2)
      const children = await harness.agents.runs.list({
        projectId,
        kinds: ["subagent"],
        parentRunId: next.id,
      })
      expect(children.total).toBe(0)
      expect(modelText(harness.parentRequests[2])).toContain("It does not continue")
    } finally {
      await settle(harness.worker.stop(), "worker stop")
    }
  })

  // Removal proofs: report `continues` without the caller's state in reportSettledAgentApprovals,
  // and the parent reads that Pay continues; drop `earlierTurnsOf` from wait_agent, and it refuses
  // Pay's run id instead of saying how Pay ended.
  test("a child that ended before it could pause does not continue, and wait_agent says how it ended", async () => {
    const harness = setup({
      parent: pausingParent((request, call) =>
        call === 3
          ? toolCalls(["wait-again", "wait_agent", { runIds: [payRunIdOf(request)] }])
          : answer("INV-2041 is paid, but the summary was lost.")
      ),
      children: {
        // Its out/ cannot be stored, so it fails once its call is held and approved.
        pay: (_request, call) =>
          call === 1
            ? toolCalls(["break", "bash", { command: BREAK_LISTING }])
            : toolCalls(["held", "bash", { command: HELD_COMMAND }]),
      },
      // Approved while the child still runs, as from another tab.
      afterHold: async () => {
        const alicesSixb = await signedIn(harness.host)
        const [waiting] = (await alicesSixb.agent.approvals.list({ statuses: ["pending"] }))
          .approvals
        await alicesSixb.agent.approvals.decide(waiting?.id ?? "", { decision: "approve" })
      },
    })
    await seedInvoice(harness.host)
    jest.useFakeTimers()
    await harness.worker.start()
    try {
      const { run } = await requestTurn(harness)
      const resumed = await underFakeTime(
        async () =>
          (await threadRuns(harness.agents, run.threadId)).find(({ id }) => id !== run.id) ?? null,
        "the resumed turn"
      )
      await terminal(harness.agents, resumed.id)
      const pay = await child(harness.agents, createSubagentRunId(run.id, PAY.key))

      expect(pay.status).toBe("failed")
      expect(
        (
          await harness.agents.runs.list({
            projectId,
            kinds: ["subagent"],
            parentRunId: resumed.id,
          })
        ).total
      ).toBe(0)
      expect(modelText(harness.parentRequests[2])).toContain("It does not continue")
      expect(modelText(harness.parentRequests[2])).not.toContain("It continues")
      expect(toolOutput(harness.parentRequests[3], "wait-again")).toMatchObject({
        results: [{ runId: pay.id, status: "failed" }],
      })
      expect(editsRun).toBe(1)
    } finally {
      await settle(harness.worker.stop(), "worker stop")
    }
  })

  // Removal proofs: drop the projections from runSubagent's replay, and the file view_file showed
  // the paused child comes back as its bare reference; leave the history out of
  // createSubagentEnvironment, and the continuation's sandbox lacks the file.
  test("replays the files a tool showed the paused child, as a turn replays its own", async () => {
    const harness = setup({
      parent: pausingParent((request, call) =>
        call === 3
          ? toolCalls(["wait-again", "wait_agent", { runIds: [payRunIdOf(request)] }])
          : answer("INV-2041 is paid.")
      ),
      children: {
        pay: (_request, call) => {
          if (call === 1) return toolCalls(["summary", "bash", { command: WRITE_SUMMARY }])
          if (call === 2) return toolCalls(["view", "view_file", { path: "out/summary.md" }])
          return toolCalls(["held", "bash", { command: HELD_COMMAND }])
        },
        "pay'": () => answer("I marked INV-2041 paid."),
      },
    })
    await seedInvoice(harness.host)
    jest.useFakeTimers()
    await harness.worker.start()
    try {
      const { run, alicesSixb } = await requestTurn(harness)
      await decide(harness, alicesSixb, run.threadId, "approve")
      const [replayed] = harness.childRequests("pay'")
      const viewed = String(toolOutput(replayed, "view"))
      const sandboxPath = /sandboxPath="([^"]+)"/.exec(viewed)?.[1] ?? ""

      // As a later turn reads a file it viewed: kept as metadata, in its sandbox at that path.
      expect(viewed).toContain('<attachment key="')
      expect(viewed).toContain('name="summary.md"')
      expect(harness.sandboxes.some((sandbox) => sandboxPath && sandbox.has(sandboxPath))).toBe(
        true
      )
    } finally {
      await settle(harness.worker.stop(), "worker stop")
    }
  })

  // Removal proofs: hand the continuation's outputs to storeChildOutputs as handed files, and the
  // summary it left unchanged does not come back; leave them out of subagentSandboxFiles, and the
  // continuation's sandbox lacks it.
  test("keeps its out/ for the continuation, which returns it; the paused child hands none", async () => {
    const harness = setup({
      parent: pausingParent((request, call) =>
        call === 3
          ? toolCalls(["wait-again", "wait_agent", { runIds: [payRunIdOf(request)] }])
          : answer("INV-2041 is paid; the summary is attached.")
      ),
      children: {
        pay: (_request, call) =>
          call === 1
            ? toolCalls(["summary", "bash", { command: WRITE_SUMMARY }])
            : toolCalls(["held", "bash", { command: HELD_COMMAND }]),
        "pay'": () => answer("I marked INV-2041 paid; out/summary.md lists it."),
      },
    })
    await seedInvoice(harness.host)
    jest.useFakeTimers()
    await harness.worker.start()
    try {
      const { run, alicesSixb } = await requestTurn(harness)
      const pay = await child(harness.agents, createSubagentRunId(run.id, PAY.key))

      expect(pay.result?.files?.map((file) => file.path)).toEqual(["summary.md"])
      const waited = await storedWait(harness.agents, run.threadId, "wait")
      expect(waited).toMatchObject({
        results: [
          {
            status: "awaiting_approval",
            filesNote: "They come back if it continues once the user decides, when it finishes.",
          },
        ],
      })
      expect(waited.results[0]).not.toHaveProperty("files")

      const { resumed } = await decide(harness, alicesSixb, run.threadId, "approve")
      const continued = await child(harness.agents, createSubagentRunId(resumed.id, PAY.key))
      // The paused child's sandbox wrote it; the continuation's got it back.
      expect(harness.sandboxes.filter((sandbox) => sandbox.has("out/summary.md"))).toHaveLength(2)
      expect(continued.result?.files?.map((file) => file.path)).toEqual(["summary.md"])
      expect(toolOutput(harness.parentRequests[3], "wait-again")).toMatchObject({
        results: [{ status: "succeeded", files: [{ path: "summary.md" }] }],
      })
    } finally {
      await settle(harness.worker.stop(), "worker stop")
    }
  })
})

/** The turn waits for Pay again once the requester decides, then answers. */
function waitsAgain(text: string): Script {
  return pausingParent((request, call) =>
    call === 3
      ? toolCalls(["wait-again", "wait_agent", { runIds: [payRunIdOf(request)] }])
      : answer(text)
  )
}

/** The sandboxes the provider keeps by name: the children's. */
function persisted(harness: ReturnType<typeof setup>): GatewaySandbox[] {
  return harness.sandboxes.filter((sandbox) => sandbox.persistedAs !== undefined)
}

describe("a paused child, on a provider that keeps sandboxes", () => {
  // Removal proofs: build the child's environment on `ephemeralRunSandbox`, as before this
  // workspace was kept, and the continuation works in a new sandbox, where its read finds no
  // notes; ignore `inSandbox` in prepareHandedFiles, and the brief it edited is handed over again;
  // copy none of the handed files on a resume, and the terms handed from the run context, which
  // the workspace's save removes, are listed but gone.
  test("continues in the workspace it paused in, with every file it left there", async () => {
    const harness = setup({
      persistent: {},
      parent: (request, call) => {
        if (call === 1) {
          return toolCalls(
            ["brief", "bash", { command: WRITE_BRIEF }],
            ["terms", "bash", { command: WRITE_TERMS }]
          )
        }
        if (call === 2) {
          return toolCalls(["spawn", "spawn_agent", { ...spawn(PAY), files: ["brief.md", TERMS] }])
        }
        if (call === 3) return toolCalls(["wait", "wait_agent", { runIds: [payRunIdOf(request)] }])
        if (call === 4) {
          return toolCalls(["wait-again", "wait_agent", { runIds: [payRunIdOf(request)] }])
        }
        return answer("INV-2041 is paid.")
      },
      children: {
        pay: (_request, call) =>
          call === 1
            ? toolCalls(
                ["notes", "bash", { command: WRITE_NOTES }],
                ["edit", "bash", { command: EDIT_BRIEF }]
              )
            : toolCalls(["held", "bash", { command: HELD_COMMAND }]),
        "pay'": (_request, call) =>
          call === 1
            ? toolCalls(["read", "bash", { command: READ_NOTES }])
            : answer("I marked INV-2041 paid."),
      },
    })
    await seedInvoice(harness.host)
    jest.useFakeTimers()
    await harness.worker.start()
    try {
      const { run, alicesSixb } = await requestTurn(harness)
      const pay = await child(harness.agents, createSubagentRunId(run.id, PAY.key))
      const paused = await harness.agents.threads.getById({ projectId, id: pay.threadId })
      const [workspace] = persisted(harness)
      const name = paused?.sandboxState?.name ?? ""

      // Saved, under its own thread's name, as the paused run left it.
      expect(paused?.sandboxState).toMatchObject({ status: "ready", initialized: true })
      expect(workspace?.persistedAs).toBe(name)

      const { resumed } = await decide(harness, alicesSixb, run.threadId, "approve")
      const continued = await child(harness.agents, createSubagentRunId(resumed.id, PAY.key))
      const [first, second] = harness.childRequests("pay'")

      expect(continued).toMatchObject({ status: "succeeded" })
      expect(harness.resumed).toEqual([name])
      expect(persisted(harness)).toHaveLength(1)
      expect(JSON.stringify(toolOutput(second, "read"))).toContain("INV-2041: approval requested.")
      // Handed over once: what the child made of it stays. What came from the run context is
      // handed again, as every run starts without it.
      expect(continued.spec.files?.map((file) => file.path).sort()).toEqual([TERMS, "brief.md"])
      expect(workspace?.text("brief.md")).toBe("Pay INV-2041. Requested.\n")
      expect(workspace?.text(TERMS)).toBe("Net 30.\n")

      // Nothing restarted, so neither its trigger nor its prompt says anything did.
      expect(JSON.stringify(first?.messages.at(-1))).not.toContain("Your sandbox restarted")
      expect(modelText(first)).not.toContain("Your sandbox was reset")
    } finally {
      await settle(harness.worker.stop(), "worker stop")
    }
  })

  // Removal proofs: save in finishSubagent whatever its finish reason (`discard: false`), and the
  // answered child's workspace is kept, ready; drop the discard from the worker's failure path,
  // and the failed child's is left busy.
  test("destroys it once the child ends, answered or failed", async () => {
    const harness = setup({
      persistent: {},
      parent: (request, call) => {
        if (call === 1) {
          return toolCalls(
            ["spawn-collect", "spawn_agent", spawn(COLLECT)],
            ["spawn-pay", "spawn_agent", spawn(PAY)]
          )
        }
        if (call === 2) {
          const runIds = ["spawn-collect", "spawn-pay"].map(
            (id) => (toolOutput(request, id) as { readonly runId: string }).runId
          )
          return toolCalls(["wait", "wait_agent", { runIds }])
        }
        return answer("Three invoices are open; paying failed.")
      },
      children: {
        collect: () => answer("Three invoices are open."),
        pay: () => {
          throw new Error("[test] The child's model is unavailable.")
        },
      },
    })
    jest.useFakeTimers()
    await harness.worker.start()
    try {
      const { run, paused: turn } = await requestTurn(harness)
      const collect = await child(harness.agents, createSubagentRunId(run.id, COLLECT.key))
      const pay = await child(harness.agents, createSubagentRunId(run.id, PAY.key))

      expect(turn).toMatchObject({ status: "succeeded" })
      expect(collect).toMatchObject({ status: "succeeded", finishReason: "stop" })
      expect(pay).toMatchObject({ status: "failed" })
      for (const ended of [collect, pay]) {
        const thread = await harness.agents.threads.getById({ projectId, id: ended.threadId })
        const workspace = persisted(harness).find(
          (sandbox) => sandbox.persistedAs === thread?.sandboxState?.name
        )
        expect(thread?.sandboxState).toMatchObject({ status: "unavailable" })
        expect(workspace?.destroyed).toBe(true)
      }
    } finally {
      await settle(harness.worker.stop(), "worker stop")
    }
  })

  // Removal proof: drop `startSubagentWorkspaceAgain` from transitionAgentThreadSandbox; the
  // retry's continuation cannot acquire the workspace the failed attempt's run destroyed, and fails.
  for (const attempt of ["answers", "fails"] as const) {
    test(`continues again when its resumed turn is retried, after a continuation that ${attempt}`, async () => {
      const harness = setup({
        persistent: {},
        parent: pausingParent((request, call) => {
          if (call === 3 || call === 5) {
            return toolCalls(["wait-again", "wait_agent", { runIds: [payRunIdOf(request)] }])
          }
          if (call === 4) throw new Error("The parent's model is unavailable.")
          return answer("INV-2041 is paid.")
        }),
        children: {
          pay: (_request, call) =>
            call === 1
              ? toolCalls(["summary", "bash", { command: WRITE_SUMMARY }])
              : toolCalls(["held", "bash", { command: HELD_COMMAND }]),
          "pay'": (_request, call) => {
            if (call === 1 && attempt === "fails") throw new Error("[test] The model is down.")
            return answer(call === 1 ? "First attempt: marked paid." : "I marked INV-2041 paid.")
          },
        },
      })
      await seedInvoice(harness.host)
      jest.useFakeTimers()
      await harness.worker.start()
      try {
        const { run, alicesSixb } = await requestTurn(harness)
        const { resumed } = await decide(harness, alicesSixb, run.threadId, "approve")
        const pay = await child(harness.agents, createSubagentRunId(run.id, PAY.key))
        const first = await child(harness.agents, createSubagentRunId(resumed.id, PAY.key))
        const [kept] = persisted(harness)

        expect(first.status).toBe(attempt === "answers" ? "succeeded" : "failed")
        expect(kept?.destroyed).toBe(true)

        const { run: retried } = await settle(alicesSixb.agent.runs.retry(resumed.id), "retry")
        await terminal(harness.agents, retried.id)
        const again = await child(harness.agents, createSubagentRunId(retried.id, PAY.key))
        const thread = await harness.agents.threads.getById({ projectId, id: pay.threadId })
        const replacement = persisted(harness).at(-1)

        // A fresh workspace, with what the paused run left in out/ given back, and told so.
        expect(again).toMatchObject({
          status: "succeeded",
          result: { text: "I marked INV-2041 paid." },
        })
        expect(replacement?.persistedAs).not.toBe(kept?.persistedAs)
        expect(replacement?.has("out/summary.md")).toBe(true)
        expect(thread?.sandboxState).toMatchObject({
          status: "unavailable",
          resetAt: expect.any(String),
        })
        expect(modelText(harness.childRequests("pay'").at(-1))).toContain(
          "Your sandbox was reset at"
        )
      } finally {
        await settle(harness.worker.stop(), "worker stop")
      }
    })
  }

  // Removal proof: save a paused child's workspace as a turn's (`preserve` for every thread); the
  // failed snapshot fails the child instead of pausing it, and its stopped VM stays.
  test("still pauses when its snapshot fails, and continues from its out/", async () => {
    const harness = setup({
      persistent: { stopFails: true },
      parent: waitsAgain("INV-2041 is paid."),
      children: {
        pay: (_request, call) =>
          call === 1
            ? toolCalls(["summary", "bash", { command: WRITE_SUMMARY }])
            : toolCalls(["held", "bash", { command: HELD_COMMAND }]),
        "pay'": () => answer("I marked INV-2041 paid."),
      },
    })
    await seedInvoice(harness.host)
    jest.useFakeTimers()
    await harness.worker.start()
    try {
      const { run, alicesSixb } = await requestTurn(harness)
      const pay = await child(harness.agents, createSubagentRunId(run.id, PAY.key))
      const [unsaved] = persisted(harness)

      expect(pay).toMatchObject({ status: "succeeded", finishReason: "awaiting_approval" })
      expect(unsaved?.destroyed).toBe(true)

      const { resumed } = await decide(harness, alicesSixb, run.threadId, "approve")
      const continued = await child(harness.agents, createSubagentRunId(resumed.id, PAY.key))
      const replacement = persisted(harness).at(-1)

      expect(continued).toMatchObject({ status: "succeeded" })
      expect(harness.resumed).toEqual([])
      expect(replacement?.persistedAs).not.toBe(unsaved?.persistedAs)
      expect(replacement?.has("out/summary.md")).toBe(true)
      expect(modelText(harness.childRequests("pay'")[0])).toContain("Your sandbox was reset at")
    } finally {
      await settle(harness.worker.stop(), "worker stop")
    }
  })

  // Removal proof: open the first run's workspace eagerly (`session.open()` for every thread); the
  // child's model is not called until its sandbox is created.
  test("lets a child's first run start before its workspace is created", async () => {
    let create = () => {}
    const created = new Promise<void>((resolve) => {
      create = resolve
    })
    const harness = setup({
      persistent: { created },
      parent: (request, call) => {
        if (call === 1) return toolCalls(["spawn-collect", "spawn_agent", spawn(COLLECT)])
        if (call === 2) {
          const collect = toolOutput(request, "spawn-collect") as { readonly runId: string }
          return toolCalls(["wait", "wait_agent", { runIds: [collect.runId] }])
        }
        return answer("Three invoices are open.")
      },
      children: { collect: () => answer("Three invoices are open.") },
    })
    jest.useFakeTimers()
    await harness.worker.start()
    try {
      const alicesSixb = await signedIn(harness.host)
      const { run } = await settle(alicesSixb.agent.runs.request({ text: "List them." }), "request")
      await underFakeTime(() => harness.childRequests("collect").length > 0, "child's first call")
      expect(persisted(harness)).toHaveLength(0)

      create()
      await terminal(harness.agents, run.id)
      const collect = await child(harness.agents, createSubagentRunId(run.id, COLLECT.key))
      expect(collect).toMatchObject({ status: "succeeded" })
      expect(persisted(harness)[0]?.destroyed).toBe(true)
    } finally {
      create()
      await settle(harness.worker.stop(), "worker stop")
    }
  })

  // Removal proof: give a replaced workspace only the handed files, as a resumed one
  // (`resumed: true` in createSubagentEnvironment); the summary its paused run left in out/ is not
  // in the new sandbox, and the continuation returns none.
  test("starts again blank when its files were lost, with its out/ given back, and is told so", async () => {
    const harness = setup({
      persistent: { lost: () => true },
      parent: waitsAgain("INV-2041 is paid; the summary is attached."),
      children: {
        pay: (_request, call) =>
          call === 1
            ? toolCalls(["summary", "bash", { command: WRITE_SUMMARY }])
            : toolCalls(["held", "bash", { command: HELD_COMMAND }]),
        "pay'": () => answer("I marked INV-2041 paid; out/summary.md lists it."),
      },
    })
    await seedInvoice(harness.host)
    jest.useFakeTimers()
    await harness.worker.start()
    try {
      const { run, alicesSixb } = await requestTurn(harness)
      const pay = await child(harness.agents, createSubagentRunId(run.id, PAY.key))
      const { resumed } = await decide(harness, alicesSixb, run.threadId, "approve")
      const continued = await child(harness.agents, createSubagentRunId(resumed.id, PAY.key))
      const [kept, replacement] = persisted(harness)
      const thread = await harness.agents.threads.getById({ projectId, id: pay.threadId })
      const [first] = harness.childRequests("pay'")

      expect(harness.resumed).toEqual([])
      expect(replacement?.persistedAs).not.toBe(kept?.persistedAs)
      expect(thread?.sandboxState).toMatchObject({
        name: replacement?.persistedAs,
        resetAt: expect.any(String),
      })
      expect(replacement?.has("out/summary.md")).toBe(true)
      expect(continued.result?.files?.map((file) => file.path)).toEqual(["summary.md"])

      // Its trigger was written expecting the workspace back; the prompt says it was not.
      expect(JSON.stringify(first?.messages.at(-1))).not.toContain("Your sandbox restarted")
      expect(modelText(first)).toContain("Your sandbox was reset at")
    } finally {
      await settle(harness.worker.stop(), "worker stop")
    }
  })
})

/** Drops what tells a parent that its child finished, as a lost record would. */
/** How much fake time passes until `check` holds. */
async function elapsedUntil(check: () => boolean | Promise<boolean>, label: string) {
  const startedAt = Date.now()
  await underFakeTime(check, label)
  return Date.now() - startedAt
}

/** A way a turn waits for Collect while it works. */
interface ChildWait {
  readonly name: string
  readonly parent: Script
  /** Count, from now on, the reads of Collect's run the wait makes. */
  readonly countReads: (agents: AgentStorage, turnId: string) => { readonly count: number }
  readonly over: (harness: ReturnType<typeof setup>) => Promise<boolean>
}

const WAITS: ChildWait[] = [
  {
    name: "wait_agent",
    parent: (request, call) => {
      if (call === 1) return toolCalls(["spawn-collect", "spawn_agent", spawn(COLLECT)])
      if (call === 2) {
        const collect = toolOutput(request, "spawn-collect") as { readonly runId: string }
        return toolCalls(["wait", "wait_agent", { runIds: [collect.runId] }])
      }
      return answer("Three invoices are open.")
    },
    countReads: (agents, turnId) => {
      const reads = { count: 0 }
      const getByIds = agents.runs.getByIds.bind(agents.runs)
      agents.runs.getByIds = (input) => {
        if (input.ids.includes(createSubagentRunId(turnId, COLLECT.key))) reads.count += 1
        return getByIds(input)
      }
      return reads
    },
    over: async (harness) => harness.parentRequests.length === 3,
  },
  {
    name: "a turn that pauses on its own call",
    parent: (_request, call) =>
      call === 1
        ? toolCalls(["spawn-collect", "spawn_agent", spawn(COLLECT)])
        : toolCalls(["held", "bash", { command: HELD_COMMAND }]),
    countReads: (agents, turnId) => {
      const reads = { count: 0 }
      const list = agents.runs.list.bind(agents.runs)
      agents.runs.list = (input) => {
        if (input.parentRunId === turnId) reads.count += 1
        return list(input)
      }
      return reads
    },
    over: async (harness) => {
      const [turn] = (await harness.agents.runs.list({ projectId, kinds: ["conversation"] })).runs
      return turn?.status === "succeeded"
    },
  },
]

/**
 * Collect works a minute while its parent waits, then finishes just after one of the wait's
 * re-checks: only the wake of its finish ends the wait before the next.
 */
async function waitOnCollect(wait: ChildWait, options: { readonly unheard?: boolean } = {}) {
  let releaseCollect!: () => void
  const collectReleased = new Promise<void>((resolve) => {
    releaseCollect = resolve
  })
  const harness = setup({
    parent: wait.parent,
    children: {
      collect: async () => {
        await collectReleased
        return answer("Three invoices are open.")
      },
    },
  })
  // Its end recorded where the turn's mailbox does not hear it: by the API, or a repair pass.
  if (options.unheard) spyOn(FamilyMailbox.prototype, "finished").mockImplementation(() => {})
  jest.useFakeTimers()
  await harness.worker.start()
  try {
    const alicesSixb = await signedIn(harness.host)
    const { run } = await settle(
      alicesSixb.agent.runs.request({ text: "List the open invoices.", approvalMode: "manual" }),
      "request"
    )
    await underFakeTime(() => harness.parentRequests.length === 2, "the parent waits")
    const reads = wait.countReads(harness.agents, run.id)

    const minuteFrom = Date.now()
    await underFakeTime(() => Date.now() - minuteFrom >= 60_000, "a minute of Collect's work")
    const readsInAMinute = reads.count

    const before = reads.count
    await underFakeTime(() => reads.count > before, "a re-check")
    releaseCollect()
    const waitedAfterFinish = await elapsedUntil(() => wait.over(harness), "the wait is over")
    return { readsInAMinute, waitedAfterFinish }
  } finally {
    releaseCollect()
    await settle(harness.worker.stop(), "worker stop")
  }
}

describe.each(WAITS)("a wait for a child at work: $name", (wait) => {
  // Removal proofs: drop the wake from the wait's `delay`, and it ends only at its next re-check,
  // CHILD_WAIT_RECHECK_MS later; set CHILD_WAIT_RECHECK_MS back to the 250 ms poll it replaced,
  // and the wait reads Collect's run 240 times a minute.
  test("ends as the child finishes, and reads its run once per re-check meanwhile", async () => {
    const { readsInAMinute, waitedAfterFinish } = await waitOnCollect(wait)

    expect(waitedAfterFinish).toBeLessThan(1_000)
    // A re-check every 5 s: 12 reads a minute, where the poll it replaced made 240.
    expect(readsInAMinute).toBeGreaterThanOrEqual(11)
    expect(readsInAMinute).toBeLessThanOrEqual(13)
  })

  // Removal proof: wait for the wake alone, without CHILD_WAIT_RECHECK_MS bounding the delay; the
  // end nothing wakes it for holds the wait for good, past what fake time drives here.
  test("still ends at its next re-check when nothing wakes it for the child's end", async () => {
    const { waitedAfterFinish } = await waitOnCollect(wait, { unheard: true })

    expect(waitedAfterFinish).toBeGreaterThanOrEqual(CHILD_WAIT_RECHECK_MS - 100)
    expect(waitedAfterFinish).toBeLessThan(CHILD_WAIT_RECHECK_MS + 1_000)
  })
})

describe("a retried resume whose earlier attempt's continuation is still stopping", () => {
  // Removal proof: wait CHILD_WAIT_RECHECK_MS in clearDeadAttempts, as for this turn's own
  // children; the stopped run's finish goes to the failed attempt's inbox, which the retry does not
  // hear, so the retry continues the child only at its next re-check, seconds later.
  test("continues the child soon after that run stops", async () => {
    let reached = () => {}
    const reachedBlock = new Promise<void>((resolve) => {
      reached = resolve
    })
    let release = () => {}
    const released = new Promise<void>((resolve) => {
      release = resolve
    })
    blocking = () => {
      reached()
      return released
    }
    const harness = setup({
      parent: pausingParent(async (request, call) => {
        // The resumed turn fails while its continuation is in its command.
        if (call === 3) {
          await reachedBlock
          throw new Error("The parent's model is unavailable.")
        }
        if (call === 4) {
          return toolCalls(["wait-again", "wait_agent", { runIds: [payRunIdOf(request)] }])
        }
        return answer("INV-2041 is paid.")
      }),
      children: {
        pay: () => toolCalls(["held", "bash", { command: HELD_COMMAND }]),
        "pay'": (_request, call) =>
          call === 1
            ? toolCalls(["block", "bash", { command: BLOCK }])
            : answer("I marked INV-2041 paid."),
      },
    })
    await seedInvoice(harness.host)
    jest.useFakeTimers()
    await harness.worker.start()
    try {
      const { run, alicesSixb } = await requestTurn(harness)
      const { resumed } = await decide(harness, alicesSixb, run.threadId, "approve")
      const dead = await child(harness.agents, createSubagentRunId(resumed.id, PAY.key))
      expect(resumed).toMatchObject({ status: "failed" })
      expect(dead.status).toBe("running")

      const { run: retried } = await settle(alicesSixb.agent.runs.retry(resumed.id), "retry")
      const again = createSubagentRunId(retried.id, PAY.key)
      // The retry waits for the stopping run before it continues the child.
      await underFakeTime(() => Date.now() - dead.createdAt.getTime() > 10_000, "the retry waits")
      expect(await harness.agents.runs.getById({ projectId, id: again })).toBeNull()

      release()
      const continuedAfter = await elapsedUntil(
        async () => (await harness.agents.runs.getById({ projectId, id: again })) !== null,
        "the retry continues the child"
      )
      expect(continuedAfter).toBeLessThan(OTHER_TURN_RECHECK_MS + 500)
      expect(await terminal(harness.agents, retried.id)).toMatchObject({ status: "succeeded" })
    } finally {
      release()
      await settle(harness.worker.stop(), "worker stop")
    }
  })
})

describe("a wait for a child of an earlier turn still stopping", () => {
  // Removal proof: wait CHILD_WAIT_RECHECK_MS for every child, as for this turn's own; the child's
  // finish goes to the earlier turn's inbox, which this one does not hear, so the wait ends only at
  // its next re-check, seconds later.
  test("ends soon after that child stops", async () => {
    let reached = () => {}
    const reachedBlock = new Promise<void>((resolve) => {
      reached = resolve
    })
    let release = () => {}
    const released = new Promise<void>((resolve) => {
      release = resolve
    })
    blocking = () => {
      reached()
      return released
    }
    const harness = setup({
      parent: async (request, call) => {
        if (call === 1) return toolCalls(["spawn", "spawn_agent", spawn(PAY)])
        // The turn ends while its child is in its command, which outlives the cancel.
        if (call === 2) {
          await reachedBlock
          return answer("Pay is on it.")
        }
        if (call === 3) return toolCalls(["wait", "wait_agent", { runIds: [payRunIdOf(request)] }])
        return answer("Pay was stopped.")
      },
      children: {
        pay: (_request, call) =>
          call === 1
            ? toolCalls(["block", "bash", { command: BLOCK }])
            : answer("I marked INV-2041 paid."),
      },
    })
    jest.useFakeTimers()
    await harness.worker.start()
    try {
      const { run, alicesSixb } = await requestTurn(harness)
      const pay = await child(harness.agents, createSubagentRunId(run.id, PAY.key))
      expect(pay.status).toBe("running")

      const { run: next } = await settle(
        alicesSixb.agent.runs.request({ text: "Is it paid?", threadId: run.threadId }),
        "next request"
      )
      await underFakeTime(() => harness.parentRequests.length === 3, "the next turn waits")
      const waitingFrom = Date.now()
      await underFakeTime(() => Date.now() - waitingFrom >= 10_000, "the wait goes on")
      expect(harness.parentRequests).toHaveLength(3)

      release()
      const waitedAfterStop = await elapsedUntil(
        () => harness.parentRequests.length === 4,
        "the wait is over"
      )
      expect(waitedAfterStop).toBeLessThan(OTHER_TURN_RECHECK_MS + 500)
      expect(await terminal(harness.agents, next.id)).toMatchObject({ status: "succeeded" })
    } finally {
      release()
      await settle(harness.worker.stop(), "worker stop")
    }
  })
})
