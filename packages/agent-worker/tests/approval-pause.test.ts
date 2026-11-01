import { afterEach, describe, expect, jest, spyOn, test } from "bun:test"
import { AGENT_RUNTIME_PROFILE } from "@sixb/cli-core"
import {
  type AgentApprovalCall,
  agent,
  type CommandResult,
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
  type SandboxFileRecord,
  SixbHost,
} from "@sixb/core"
import {
  AGENT_APPROVAL_EXECUTION_LEASE_MS,
  holdAgentApprovalCall,
} from "@sixb/core/internal/agents"
import { emptyGrantIndex } from "@sixb/core/internal/authorization"
import { bindRequestExecution } from "@sixb/core/internal/request-execution"
import type { LanguageModelRequest } from "@sixb/core/models"
import type { AgentRunRecord, AgentStorage } from "@sixb/core/storage"
import { createTestSixb } from "@sixb/core/testing"
import { waitFor as pollFor } from "../../agent/tests/helpers"
import { testStream, WorkerTestModel } from "../../agent/tests/worker-model-fixture"
import { AgentWorker } from "../src"
import { repairAgentApprovals } from "../src/approval-repair"
import { expectReplayedPrefix, withJsonbKeyOrder } from "./replay-bytes"

const projectId = "agent-approval-pause"
const alice = { type: "user", id: "usr_alice" } as const
const HELD_COMMAND = "sixb actions request mark-paid --subject invoice:INV-2041 > /dev/null"

const Invoice = defineObjectType({
  id: "invoice",
  name: "Invoice",
  properties: [prop("id", "string", { primary: true, required: true }), prop("status", "string")],
})

/** How many times an approved call's edits ran: a call runs once, whoever repairs it. */
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

const waitFor: typeof pollFor = (fn, options = {}) => pollFor(fn, { intervalMs: 1, ...options })

afterEach(() => {
  jest.useRealTimers()
})

/**
 * A sandbox whose `sixb actions request` reaches a stand-in for the agent API gateway: core holds
 * the call by the turn's mode, as the gateway does, and the command prints nothing, as its output
 * goes to `/dev/null`.
 */
class GatewaySandbox implements Sandbox {
  readonly id = "gateway-sandbox"
  readonly provider = "test"
  readonly status = "running"
  readonly workingDirectory = "/tmp/sixb-gateway-sandbox"

  /** As a firewall adds credentials: the URL itself. */
  credentialedUrl(url: string): string {
    return url
  }

  constructor(
    private readonly onHeldCommand: (runId: string, signal?: AbortSignal) => Promise<void>
  ) {}

  async writeFiles(_files: readonly SandboxFileRecord[]): Promise<void> {}

  async runCommand(
    command: string,
    args: readonly string[] = [],
    options: RunCommandOptions = {}
  ): Promise<CommandResult> {
    const script = args.at(-1) ?? ""
    if (command === "bash" && script.includes("SIXB_BASH_ENV_READY")) {
      return ok("node\t22.0.0\tsixb CLI 1\n")
    }
    if (command === "bash" && script === "sixb status") {
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
    if (command === "bash" && script === HELD_COMMAND) {
      await this.onHeldCommand(String(options.env?.SIXB_RUN_ID), options.signal)
      // Exit code 4: the call waits. The model sees no output at all.
      return { exitCode: 4, stdout: "", stderr: "", durationMs: 1 }
    }
    return ok("")
  }

  async stop(): Promise<void> {}

  async destroy(): Promise<void> {}
}

function ok(stdout: string): CommandResult {
  return { exitCode: 0, stdout, stderr: "", durationMs: 1 }
}

/** The model's first turn previews the call and makes it; any later turn answers in text. */
function scriptedModel() {
  const requests: LanguageModelRequest[] = []
  const model = new WorkerTestModel({
    stream: async (request) => {
      requests.push(request)
      if (requests.length === 1) {
        return testStream([
          { type: "stream-start", warnings: [] },
          { type: "text-start", id: "preview" },
          { type: "text-delta", id: "preview", delta: "I'll mark INV-2041 paid." },
          { type: "text-end", id: "preview" },
          {
            type: "tool-call",
            toolCallId: "held",
            toolName: "bash",
            input: JSON.stringify({ command: HELD_COMMAND }),
          },
          finish("tool-calls"),
        ])
      }
      return testStream([
        { type: "stream-start", warnings: [] },
        { type: "text-start", id: "answer" },
        { type: "text-delta", id: "answer", delta: "INV-2041 is paid." },
        { type: "text-end", id: "answer" },
        finish("stop"),
      ])
    },
  })
  return { model, requests }
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

const PNG_BYTES = Uint8Array.from(
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=",
    "base64"
  )
)

function finish(finishReason: "stop" | "tool-calls") {
  return {
    type: "finish",
    finishReason,
    rawFinishReason: finishReason,
    usage: { inputTokens: 10, outputTokens: 5 },
  } as const
}

function setup(
  onHeldCommand: (input: {
    readonly runId: string
    readonly host: SixbHost
    readonly signal?: AbortSignal
  }) => Promise<void>,
  options: {
    /** Another host's storage, as a second worker process shares it. */
    readonly storage?: InMemoryStorage
    /** The model's script, instead of a call it holds then an answer. */
    readonly scripted?: ReturnType<typeof scriptedModel>
  } = {}
) {
  const { model, requests } = options.scripted ?? scriptedModel()
  const storage = options.storage ?? new InMemoryStorage()
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
    sandboxes: {
      supportsRequestCredentials: true,
      create: async () =>
        new GatewaySandbox((runId, signal) => onHeldCommand({ runId, host, signal })),
    },
    models: { language: [model] },
  })
  return { host, agents: requireAgents(host), requests }
}

/** What the gateway does with the call: the turn's mode holds it for whoever asked for the turn. */
async function holdTheCall(host: SixbHost, runId: string, call: AgentApprovalCall = heldCall) {
  const agents = requireAgents(host)
  const run = await agents.runs.getById({ projectId, id: runId })
  if (!run) throw new Error(`Expected run '${runId}'.`)
  const hold = await holdAgentApprovalCall(agents, {
    projectId,
    run,
    requestedBy: alice,
    call,
  })
  if (hold.kind !== "held") throw new Error(`Expected the call to be held, got '${hold.kind}'.`)
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

function startWorker(host: SixbHost) {
  return new AgentWorker(host, {
    apiBaseUrl: "http://localhost:3002/api/",
  })
}

async function terminal(agents: AgentStorage, runId: string): Promise<AgentRunRecord> {
  return waitFor(
    async () => {
      const run = await agents.runs.getById({ projectId, id: runId })
      return run && run.status !== "queued" && run.status !== "running" ? run : null
    },
    { label: `run ${runId} terminal` }
  )
}

async function threadRuns(agents: AgentStorage, threadId: string) {
  return (await agents.runs.list({ projectId, threadId, order: "asc" })).runs
}

function modelText(request: LanguageModelRequest | undefined): string {
  return JSON.stringify(request?.messages ?? [])
}

describe("a turn whose call waits for approval", () => {
  // Guard proof: drop `pauseAfterStep` from `runAgentTurn`; the model is called a second time in
  // the same turn, and the turn finishes `stop` with nothing to resume.
  test("pauses after that step, even when the command's output went to /dev/null", async () => {
    const { host, agents, requests } = setup(({ runId, host }) => holdTheCall(host, runId))
    const alicesSixb = await signedIn(host)
    await seedInvoice(host)
    const worker = startWorker(host)
    await worker.start()
    try {
      const { run } = await alicesSixb.agent.runs.request({
        text: "Mark INV-2041 paid",
        approvalMode: "manual",
      })
      const paused = await terminal(agents, run.id)

      expect(paused).toMatchObject({ status: "succeeded", finishReason: "awaiting_approval" })
      expect(requests).toHaveLength(1)
      const { messages } = await agents.messages.list({ projectId, threadId: run.threadId })
      expect(messages.map((message) => message.role)).toEqual(["user", "assistant"])
      expect(messages[1]?.parts).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: "text", text: "I'll mark INV-2041 paid." }),
          expect.objectContaining({ type: "tool-call", toolCallId: "held" }),
        ])
      )
      expect(
        (await agents.threads.getById({ projectId, id: run.threadId }))?.activeRunId
      ).toBeNull()
      expect(await host.storage.actionRuns?.getById({ projectId, id: "act_mark_paid" })).toBeNull()
    } finally {
      await worker.stop()
    }
  })

  // Guard proof: resolve the defaults in `resumedConversationRunSpec` instead of keeping the paused
  // turn's spec; the resumed turn loses its reasoning and the spec differs.
  test("resumes when its requester approves it, and the model reads how it ended", async () => {
    const { host, agents, requests } = setup(({ runId, host }) => holdTheCall(host, runId))
    const alicesSixb = await signedIn(host)
    await seedInvoice(host)
    const worker = startWorker(host)
    await worker.start()
    try {
      const { run } = await alicesSixb.agent.runs.request({
        text: "Mark INV-2041 paid",
        approvalMode: "manual",
        reasoning: "high",
        timeZone: "Europe/Paris",
      })
      const paused = await terminal(agents, run.id)
      const [held] = (await alicesSixb.agent.approvals.list({ threadId: run.threadId })).approvals

      const decision = await alicesSixb.agent.approvals.decide(held?.id ?? "", {
        decision: "approve",
      })
      const resumed = await terminal(agents, decision.run?.id ?? "")

      expect(resumed).toMatchObject({ status: "succeeded", finishReason: "stop" })
      expect(resumed.kind === "conversation" ? resumed.spec : null).toEqual(
        paused.kind === "conversation" ? paused.spec : undefined
      )
      expect(paused).toMatchObject({
        spec: { approvalMode: "manual", reasoning: "high", timeZone: "Europe/Paris" },
      })
      expect(requests[1]?.reasoning).toBe("high")
      expect(requests).toHaveLength(2)
      expect(modelText(requests[1])).toContain(
        `<sixb_approval id=\\"${held?.id}\\" status=\\"approved\\">`
      )
      expect((await host.storage.actionRuns?.list({ projectId }))?.total).toBe(1)
      expect((await createTestSixb(host).objects.get("invoice", "INV-2041"))?.properties).toEqual({
        id: "INV-2041",
        status: "paid",
      })
    } finally {
      await worker.stop()
    }
  })

  // Guard proofs: inline only the newest user message's files in fileWorkItems, and the resumed
  // turn reads the request's attachments as metadata; serialize tool JSON with JSON.stringify in
  // models/protocols, and the bash output the jsonb double reordered prints other bytes.
  test("resumes with every byte the paused turn sent last, its attachments included", async () => {
    const requests: LanguageModelRequest[] = []
    const model = new WorkerTestModel({
      capabilities: { inputMediaTypes: ["image/png"], localTools: true },
      stream: async (request) => {
        requests.push(request)
        if (requests.length > 2) return answer("INV-2041 is paid.")

        const command = requests.length === 1 ? "ls invoices" : HELD_COMMAND
        return testStream([
          { type: "stream-start", warnings: [] },
          {
            type: "tool-call",
            toolCallId: `call-${requests.length}`,
            toolName: "bash",
            input: JSON.stringify({ command }),
          },
          finish("tool-calls"),
        ])
      },
    })
    const { host, agents } = setup(({ runId, host }) => holdTheCall(host, runId), {
      storage: withJsonbKeyOrder(new InMemoryStorage()),
      scripted: { model, requests },
    })
    const alicesSixb = await signedIn(host)
    await seedInvoice(host)
    const attachments = await Promise.all([
      host.blobStorage.put({
        body: new TextEncoder().encode("invoice,amount\nINV-2041,1200\n"),
        fileName: "invoices.csv",
        mediaType: "text/csv",
      }),
      host.blobStorage.put({ body: PNG_BYTES, fileName: "stamp.png", mediaType: "image/png" }),
    ])
    const worker = startWorker(host)
    await worker.start()
    try {
      const { run } = await alicesSixb.agent.runs.request({
        text: "Mark the invoice in this file paid",
        approvalMode: "manual",
        attachments,
      })
      await terminal(agents, run.id)
      const [held] = (await alicesSixb.agent.approvals.list({ threadId: run.threadId })).approvals
      const decision = await alicesSixb.agent.approvals.decide(held?.id ?? "", {
        decision: "approve",
      })
      await terminal(agents, decision.run?.id ?? "")

      expect(requests).toHaveLength(3)
      expectReplayedPrefix(requests[1], requests[2], model.providerId)
      expect(modelText(requests[2])).toContain("INV-2041,1200")
      if (typeof Bun.Image === "function") {
        expect(modelText(requests[2])).toContain(Buffer.from(PNG_BYTES).toString("base64"))
      }
    } finally {
      await worker.stop()
    }
  })

  // Guard proof: drop `resumeIfDecided` from the worker; the decision found the turn running, so
  // nothing resumes it until the repair pass.
  test("resumes at once when its requester decided while it still ran", async () => {
    const { host, agents, requests } = setup(async ({ runId, host }) => {
      await holdTheCall(host, runId)
      const alicesSixb = await signedIn(host)
      const [held] = (await alicesSixb.agent.approvals.list({ statuses: ["pending"] })).approvals
      const decision = await alicesSixb.agent.approvals.decide(held?.id ?? "", {
        decision: "deny",
      })
      if (decision.run) throw new Error("A running turn cannot resume yet.")
    })
    const alicesSixb = await signedIn(host)
    const worker = startWorker(host)
    await worker.start()
    try {
      const { run } = await alicesSixb.agent.runs.request({
        text: "Mark INV-2041 paid",
        approvalMode: "manual",
      })
      expect(await terminal(agents, run.id)).toMatchObject({ finishReason: "awaiting_approval" })

      const resumed = await waitFor(
        async () => (await threadRuns(agents, run.threadId))[1] ?? null,
        { label: "resumed turn" }
      )

      expect(await terminal(agents, resumed.id)).toMatchObject({ status: "succeeded" })
      expect(modelText(requests[1])).toContain('status=\\"denied\\"')
    } finally {
      await worker.stop()
    }
  })

  // Guard proof: leave pending approvals alone in `runs.finish` when a turn is cancelled; the call
  // stays pending under a stopped turn.
  test("stopped before it could pause, it takes its waiting call with it", async () => {
    const { host, agents } = setup(async ({ runId, host, signal }) => {
      await holdTheCall(host, runId)
      await (await signedIn(host)).agent.runs.cancel(runId)
      // The command runs until the stop reaches it, as a long one would.
      await new Promise<void>((resolve) => {
        if (signal?.aborted) resolve()
        signal?.addEventListener("abort", () => resolve(), { once: true })
      })
    })
    const alicesSixb = await signedIn(host)
    const worker = startWorker(host)
    await worker.start()
    try {
      const { run } = await alicesSixb.agent.runs.request({
        text: "Mark INV-2041 paid",
        approvalMode: "manual",
      })

      expect(await terminal(agents, run.id)).toMatchObject({ status: "cancelled" })
      expect((await agents.approvals.list({ projectId })).approvals).toEqual([
        expect.objectContaining({ status: "cancelled" }),
      ])
    } finally {
      await worker.stop()
    }
  })
})

describe("the approval repair pass", () => {
  // Guard proof: expire as of the epoch in `repairAgentApprovals` instead of `now`; the call stays
  // pending after its seven days.
  test("expires a call nobody decided within seven days, and the turn never resumes", async () => {
    const { host, agents } = setup(({ runId, host }) => holdTheCall(host, runId))
    const paused = await pauseATurn(host, agents)

    jest.useFakeTimers()
    jest.setSystemTime(Date.now() + 7 * 24 * 60 * 60_000 - 1_000)
    await repairAgentApprovals({ host, agents })
    expect((await agents.approvals.list({ projectId, statuses: ["pending"] })).total).toBe(1)

    jest.setSystemTime(Date.now() + 1_000)
    await repairAgentApprovals({ host, agents })

    expect((await agents.approvals.list({ projectId, statuses: ["expired"] })).total).toBe(1)
    expect(await threadRuns(agents, paused.threadId)).toHaveLength(1)
  })

  // Guard proof: drop the executor's `complete` from `repairTurn`; the call never runs and the turn
  // never resumes.
  test("runs an approved call a crash left without its outcome, then resumes the turn", async () => {
    const { host, agents } = setup(({ runId, host }) => holdTheCall(host, runId))
    await seedInvoice(host)
    const paused = await pauseATurn(host, agents)
    const held = await approveWithoutRunning(agents)

    jest.useFakeTimers()
    jest.setSystemTime(Date.now() + AGENT_APPROVAL_EXECUTION_LEASE_MS - 1_000)
    await repairAgentApprovals({ host, agents })
    expect(await host.storage.actionRuns?.getById({ projectId, id: "act_mark_paid" })).toBeNull()

    jest.setSystemTime(Date.now() + 1_000)
    await repairAgentApprovals({ host, agents })

    expect(await agents.approvals.getById({ projectId, id: held.id })).toMatchObject({
      outcome: { kind: "action-run", runId: "act_mark_paid", status: "succeeded" },
      reportedInMessageId: expect.any(String),
    })
    const [, resumed] = await threadRuns(agents, paused.threadId)
    // Resumes never nest: the resumed turn is a sibling of the paused one.
    expect(await sourceOf(host, resumed)).toEqual(await sourceOf(host, paused))
  })

  // Guard proof: run the call without `claimExecution` in `repairTurn`; both workers run it, and
  // its edits apply twice.
  test("lets one worker run an approved call, however many repair it at once", async () => {
    const storage = new InMemoryStorage()
    const first = setup(({ runId, host }) => holdTheCall(host, runId), { storage })
    const second = setup(({ runId, host }) => holdTheCall(host, runId), { storage })
    await seedInvoice(first.host)
    await pauseATurn(first.host, first.agents)
    await approveWithoutRunning(first.agents)
    editsRun = 0

    jest.useFakeTimers()
    jest.setSystemTime(Date.now() + AGENT_APPROVAL_EXECUTION_LEASE_MS + 1_000)
    await Promise.all([
      repairAgentApprovals({ host: first.host, agents: first.agents }),
      repairAgentApprovals({ host: second.host, agents: second.agents }),
    ])

    expect(editsRun).toBe(1)
  })

  // Guard proof: let `complete` bind the turn's execution without catching `AgentRunScopeError`;
  // the call stays without its outcome, and every pass tries it again.
  test("records that an approved call cannot run once its sign-in ended, and stops the turn", async () => {
    const { host, agents } = setup(({ runId, host }) => holdTheCall(host, runId))
    await seedInvoice(host)
    const paused = await pauseATurn(host, agents)
    const held = await approveWithoutRunning(agents)
    await signOut(host, paused)
    const warn = spyOn(console, "warn").mockImplementation(() => {})

    try {
      jest.useFakeTimers()
      jest.setSystemTime(Date.now() + AGENT_APPROVAL_EXECUTION_LEASE_MS + 1_000)
      await repairAgentApprovals({ host, agents })
      await repairAgentApprovals({ host, agents })

      const approval = await agents.approvals.getById({ projectId, id: held.id })
      expect(approval?.outcome).toMatchObject({
        kind: "error",
        error: { code: "agent.approval_authority_lost" },
      })
      expect(approval?.turnStoppedAt).toBeInstanceOf(Date)
      expect(await host.storage.actionRuns?.getById({ projectId, id: "act_mark_paid" })).toBeNull()
      expect(await threadRuns(agents, paused.threadId)).toHaveLength(1)
      // Said once: the stopped turn leaves the pass.
      expect(warn).toHaveBeenCalledTimes(1)
    } finally {
      warn.mockRestore()
    }
  })

  // Guard proof: drop the `closed` branch of `repairTurn`; nothing stops the turn, and every pass
  // lists it again.
  test("stops a turn that can no longer resume, and leaves it out of later passes", async () => {
    const { host, agents } = setup(async ({ runId, host }) => {
      await holdTheCall(host, runId)
      await holdTheCall(host, runId, { ...heldCall, actionRunId: "act_write_off" })
    })
    const paused = await pauseATurn(host, agents)
    const [denied] = (await agents.approvals.list({ projectId })).approvals
    await agents.approvals.decide({
      projectId,
      id: denied?.id ?? "",
      decision: "denied",
      decidedBy: alice,
    })
    const warn = spyOn(console, "warn").mockImplementation(() => {})

    try {
      // The other call expires: the turn cannot resume on the denied one alone.
      jest.useFakeTimers()
      jest.setSystemTime(Date.now() + 7 * 24 * 60 * 60_000 + 1_000)
      await repairAgentApprovals({ host, agents })
      await repairAgentApprovals({ host, agents })

      expect(
        await agents.approvals.listRepairable({ projectId, claimableBefore: new Date(), limit: 10 })
      ).toEqual([])
      expect(await threadRuns(agents, paused.threadId)).toHaveLength(1)
      expect(warn).toHaveBeenCalledTimes(1)
    } finally {
      warn.mockRestore()
    }
  })
})

/** A turn of Alice's, run by a worker until it pauses on its held call. */
async function pauseATurn(host: SixbHost, agents: AgentStorage) {
  const worker = startWorker(host)
  await worker.start()
  try {
    const { run } = await (await signedIn(host)).agent.runs.request({
      text: "Mark INV-2041 paid",
      approvalMode: "manual",
    })
    const paused = await terminal(agents, run.id)
    if (paused.kind !== "conversation") throw new Error("Expected a conversation turn.")
    return paused
  } finally {
    await worker.stop()
  }
}

/** The decision was recorded, and its process died before the call ran. */
async function approveWithoutRunning(agents: AgentStorage) {
  const [held] = (await agents.approvals.list({ projectId })).approvals
  const decided = await agents.approvals.decide({
    projectId,
    id: held?.id ?? "",
    decision: "approved",
    decidedBy: alice,
  })
  if (!decided?.decided) throw new Error("Expected the call to be approved.")
  return decided.approval
}

/** End the session the turn was asked with. */
async function signOut(host: SixbHost, run: AgentRunRecord) {
  const execution = await host.storage.executions.getById({ projectId, id: run.executionId })
  const credential =
    execution?.authorizationRef.type === "principal" ? execution.authorizationRef.credential : null
  await host.storage.auth?.sessions.revoke({
    projectId,
    id: credential?.id ?? "",
    revokedAt: new Date(),
  })
}

async function sourceOf(host: SixbHost, run: AgentRunRecord | undefined) {
  const execution = await host.storage.executions.getById({
    projectId,
    id: run?.executionId ?? "",
  })
  return execution?.source
}
