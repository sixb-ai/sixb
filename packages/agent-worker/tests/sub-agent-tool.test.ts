import { describe, expect, test } from "bun:test"
import type {
  LanguageModelV4,
  LanguageModelV4StreamPart,
  LanguageModelV4Usage,
} from "@ai-sdk/provider"
import {
  type CreateSandboxOptions,
  can,
  defineAgent,
  defineGroup,
  defineRole,
  every,
  InMemoryBlobStorage,
  InMemoryBroker,
  InMemoryLakeStorage,
  InMemoryQueues,
  InMemoryStorage,
  type Principal,
  type RunCommandOptions,
  resolveAuthorizationContext,
  type Sandbox,
  type SandboxFactory,
  type SandboxFileRecord,
  SixbHost,
} from "@sixb/core"
import { agentRunQueueJobId, publishAgentRunCancel } from "@sixb/core/internal/agents"
import { createTestSixb } from "@sixb/core/testing"
import { convertArrayToReadableStream, MockLanguageModelV4 } from "ai/test"
import { AgentWorker } from "../src"
import { resolveSubAgentTargets } from "../src/sub-agent-tool"
import { waitFor } from "./helpers"

const PROJECT_ID = "sub-agent-tool-tests"
const API_BASE_URL = "http://localhost:3002/api/"
const REQUESTER: Principal = { type: "user", id: "usr_requester" }

const USAGE: LanguageModelV4Usage = {
  inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 7, text: 7, reasoning: 0 },
  raw: { input_tokens: 10, output_tokens: 7 },
}

function stream(chunks: LanguageModelV4StreamPart[]) {
  return { stream: convertArrayToReadableStream(chunks) }
}

function finish(unified: "stop" | "tool-calls"): LanguageModelV4StreamPart {
  return { type: "finish", finishReason: { unified, raw: unified }, usage: USAGE }
}

function answer(text: string): LanguageModelV4StreamPart[] {
  return [
    { type: "stream-start", warnings: [] },
    { type: "text-start", id: "t" },
    { type: "text-delta", id: "t", delta: text },
    { type: "text-end", id: "t" },
    finish("stop"),
  ]
}

/** Delegates on its first call, then reports what came back. Stateful for per-call ordering. */
function delegatingModel(target: string): MockLanguageModelV4 {
  let call = 0
  return new MockLanguageModelV4({
    modelId: "main-model",
    doStream: async () => {
      call += 1
      if (call === 1) {
        return stream([
          { type: "stream-start", warnings: [] },
          {
            type: "tool-call",
            toolCallId: "c1",
            toolName: "sub_agent",
            input: JSON.stringify({ agent: target, task: "look it up" }),
          },
          finish("tool-calls"),
        ])
      }
      return stream(answer("Delegated and done."))
    },
  })
}

class StubSandbox implements Sandbox {
  readonly id = "stub"
  readonly provider = "stub"
  readonly workingDirectory = "/tmp/stub"
  status: "running" | "stopped" | "failed" = "running"
  destroyed = false
  async writeFiles(_files: readonly SandboxFileRecord[]): Promise<void> {}
  async runCommand(
    _command: string,
    _args: readonly string[] = [],
    _options: RunCommandOptions = {}
  ) {
    return { exitCode: 0, stdout: "", stderr: "", durationMs: 1 }
  }
  async listOutputFiles() {
    return []
  }
  async readOutputFile() {
    return new Uint8Array()
  }
  async stop(): Promise<void> {
    this.status = "stopped"
  }
  async destroy(): Promise<void> {
    this.destroyed = true
    this.status = "stopped"
  }
}

class CountingSandboxFactory implements SandboxFactory {
  readonly sandboxes: StubSandbox[] = []
  async create(_options: CreateSandboxOptions = {}): Promise<Sandbox> {
    const sandbox = new StubSandbox()
    this.sandboxes.push(sandbox)
    return sandbox
  }
}

const agentUsers = defineGroup("agent-users", { label: "Agent users" })
const specialists = defineGroup("specialists", { label: "Specialists" })

/** Records every job id ever published to the agent queue, not just what is still claimable. */
function recordingQueues(enqueued: string[]): InMemoryQueues {
  const queues = new InMemoryQueues()
  const agents = queues.agents
  const enqueue = agents.enqueue.bind(agents)
  Object.defineProperty(queues, "agents", {
    value: new Proxy(agents, {
      get(target, property, receiver) {
        if (property === "enqueue") {
          return (input: Parameters<typeof enqueue>[0]) => {
            for (const job of input.jobs) {
              if (job.id) enqueued.push(job.id)
            }
            return enqueue(input)
          }
        }
        const value = Reflect.get(target, property, receiver)
        return typeof value === "function" ? value.bind(target) : value
      },
    }),
  })
  return queues
}

function buildHost(input: {
  readonly mainModel: LanguageModelV4
  readonly specialistModel: LanguageModelV4
  readonly sandboxes: SandboxFactory
  readonly queues?: InMemoryQueues
  readonly broker?: InMemoryBroker
}) {
  const researcher = defineAgent("researcher", {
    name: "Researcher",
    description: "Looks things up.",
    model: input.specialistModel,
    instructions: "Answer briefly.",
    groups: [specialists],
  })
  return new SixbHost({
    id: PROJECT_ID,
    ontology: [],
    agents: [researcher],
    mainAgent: {
      name: "Assistant",
      model: input.mainModel,
      instructions: "Delegate specialist work.",
    },
    groups: [agentUsers, specialists],
    roles: [
      // `every.agent()` rather than `can.run(mainAgent)`: `can.run` takes a definition object and
      // the main agent's definition is framework-owned, so naming it alone is not expressible.
      defineRole("agent-users.runner", {
        grantedTo: [agentUsers],
        grants: [can.run(every.agent())],
      }),
    ],
    broker: input.broker ?? new InMemoryBroker(),
    storage: new InMemoryStorage(),
    lakeStorage: new InMemoryLakeStorage(),
    blobStorage: new InMemoryBlobStorage(),
    queues: input.queues ?? new InMemoryQueues(),
    sandboxes: input.sandboxes,
  })
}

/** Request a main-agent turn the way a real signed-in request does: groups in, grants resolved. */
async function requestMainTurn(sixb: ReturnType<typeof buildHost>, groupIds: readonly string[]) {
  const auth = sixb.storage.auth
  if (!auth) throw new Error("expected auth storage")
  await auth.users.create({
    id: REQUESTER.id,
    projectId: PROJECT_ID,
    email: "requester@example.com",
  })
  for (const groupId of groupIds) {
    await auth.groupMemberships.upsert({
      projectId: PROJECT_ID,
      userId: REQUESTER.id,
      groupId,
      source: "manual",
    })
  }
  const authorization = resolveAuthorizationContext({
    principal: REQUESTER,
    groupIds,
    roles: sixb.definitions.security.listResolvedRoles(),
  })
  return createTestSixb(sixb, { authorization }).agents.runs.request({
    agentId: "main",
    text: "find out about invoices",
  })
}

async function runWorkerUntilIdle(sixb: ReturnType<typeof buildHost>, runId: string) {
  const worker = new AgentWorker(sixb, {
    apiBaseUrl: API_BASE_URL,
    idlePollMs: 5,
    skillsDir: false,
  })
  await worker.start()
  try {
    await waitFor(async () => {
      const run = await sixb.storage.agents?.runs.getById({ projectId: PROJECT_ID, id: runId })
      if (run?.status === "queued" || run?.status === "running") return undefined
      return run
    })
  } finally {
    await worker.stop()
  }
}

describe("sub_agent", () => {
  test("runs the child in the parent's slot, never through the agent queue", async () => {
    const enqueued: string[] = []
    const sixb = buildHost({
      mainModel: delegatingModel("researcher"),
      specialistModel: new MockLanguageModelV4({
        modelId: "specialist-model",
        doStream: async () => stream(answer("Invoices are late.")),
      }),
      sandboxes: new CountingSandboxFactory(),
      queues: recordingQueues(enqueued),
    })

    const requested = await requestMainTurn(sixb, ["agent-users"])
    await runWorkerUntilIdle(sixb, requested.run.id)

    const runs = await sixb.storage.agents?.runs.list({ projectId: PROJECT_ID })
    const child = runs?.runs.find((run) => run.agentId === "researcher")
    expect(child?.status).toBe("succeeded")

    // The delegating run is queued normally; the child never is. A child that reached the queue
    // would be claimed by a worker and either started a second time or reclaimed out from under
    // the in-process turn that is already running it.
    expect(enqueued).toContain(agentRunQueueJobId(requested.run.id))
    expect(enqueued).not.toContain(agentRunQueueJobId(child?.id ?? ""))
  })

  test("keeps child threads owned by the agent even though the parent runs as the user", async () => {
    const sixb = buildHost({
      mainModel: delegatingModel("researcher"),
      specialistModel: new MockLanguageModelV4({
        modelId: "specialist-model",
        doStream: async () => stream(answer("Invoices are late.")),
      }),
      sandboxes: new CountingSandboxFactory(),
    })

    const requested = await requestMainTurn(sixb, ["agent-users"])
    await runWorkerUntilIdle(sixb, requested.run.id)

    const runs = await sixb.storage.agents?.runs.list({ projectId: PROJECT_ID })
    const child = runs?.runs.find((run) => run.agentId === "researcher")
    const childThread = await sixb.storage.agents?.threads.getById({
      projectId: PROJECT_ID,
      id: child?.threadId ?? "",
    })

    // The delegating turn now runs *as the requester*, so `context.agentPrincipal` is the human.
    // Owning child threads by that principal would surface every delegated conversation in the
    // user's own thread list.
    expect(childThread?.ownerPrincipal).toEqual({ type: "serviceAccount", id: "svc_agent_main" })

    // Authorship is the agent's even though the run's *authority* is the human.
    const parentMessages = await sixb.storage.agents?.messages.list({
      projectId: PROJECT_ID,
      threadId: requested.run.threadId,
      roles: ["assistant"],
      order: "asc",
    })
    expect(parentMessages?.messages[0]?.authorPrincipal).toEqual({
      type: "serviceAccount",
      id: "svc_agent_main",
    })

    const visible = await createTestSixb(sixb, {
      authorization: resolveAuthorizationContext({
        principal: REQUESTER,
        groupIds: ["agent-users"],
        roles: sixb.definitions.security.listResolvedRoles(),
      }),
    }).agents.threads.list({})
    expect(visible.threads.map((thread) => thread.agentId)).toEqual(["main"])
  })

  test("links the child execution to the delegating one and bills it separately", async () => {
    const sixb = buildHost({
      mainModel: delegatingModel("researcher"),
      specialistModel: new MockLanguageModelV4({
        modelId: "specialist-model",
        doStream: async () => stream(answer("Invoices are late.")),
      }),
      sandboxes: new CountingSandboxFactory(),
    })

    const requested = await requestMainTurn(sixb, ["agent-users"])
    await runWorkerUntilIdle(sixb, requested.run.id)

    const runs = await sixb.storage.agents?.runs.list({ projectId: PROJECT_ID })
    const parent = runs?.runs.find((run) => run.agentId === "main")
    const child = runs?.runs.find((run) => run.agentId === "researcher")
    const childExecution = await sixb.storage.executions.getById({
      projectId: PROJECT_ID,
      id: child?.executionId ?? "",
    })

    expect(childExecution?.source).toEqual({
      type: "execution",
      executionId: parent?.executionId ?? "",
    })
    // Usage follows the execution tree rather than being copied onto the parent.
    const childUsage = await sixb.storage.aiUsage?.summarizeExecution({
      projectId: PROJECT_ID,
      executionId: child?.executionId ?? "",
    })
    expect(childUsage?.modelCallCount).toBeGreaterThan(0)
  })

  test("offers only agents the requester could run directly, and never itself", () => {
    const sixb = buildHost({
      mainModel: delegatingModel("researcher"),
      specialistModel: new MockLanguageModelV4({ modelId: "specialist-model" }),
      sandboxes: new CountingSandboxFactory(),
    })
    const roles = sixb.definitions.security.listResolvedRoles()

    const permitted = resolveSubAgentTargets({
      host: sixb,
      agentId: "main",
      requesterAuthorization: resolveAuthorizationContext({
        principal: REQUESTER,
        groupIds: ["agent-users"],
        roles,
      }),
    })
    // `main` is in the requester's grants via `every.agent()`, yet must not be offered: withholding
    // it is what keeps delegation one level deep.
    expect(permitted.map((agent) => agent.id)).toEqual(["researcher"])

    const ungranted = resolveSubAgentTargets({
      host: sixb,
      agentId: "main",
      requesterAuthorization: resolveAuthorizationContext({
        principal: REQUESTER,
        groupIds: [],
        roles,
      }),
    })
    expect(ungranted).toEqual([])

    // No requester at all denies outright rather than falling through to "no constraints".
    expect(
      resolveSubAgentTargets({ host: sixb, agentId: "main", requesterAuthorization: null })
    ).toEqual([])
  })

  test("cancels the child and releases its thread when the delegating turn is cancelled", async () => {
    const broker = new InMemoryBroker()
    const sixb = buildHost({
      mainModel: delegatingModel("researcher"),
      // Hangs until aborted, so the child is still running when the cancel lands.
      specialistModel: new MockLanguageModelV4({
        modelId: "specialist-model",
        doStream: async ({ abortSignal }) =>
          new Promise((_resolve, reject) => {
            abortSignal?.addEventListener(
              "abort",
              () => reject(new DOMException("Aborted", "AbortError")),
              { once: true }
            )
          }),
      }),
      sandboxes: new CountingSandboxFactory(),
      broker,
    })

    const requested = await requestMainTurn(sixb, ["agent-users"])
    const worker = new AgentWorker(sixb, {
      apiBaseUrl: API_BASE_URL,
      idlePollMs: 5,
      skillsDir: false,
    })
    await worker.start()
    try {
      const child = await waitFor(async () => {
        const runs = await sixb.storage.agents?.runs.list({ projectId: PROJECT_ID })
        return runs?.runs.find((run) => run.agentId === "researcher" && run.status === "running")
      })
      await publishAgentRunCancel(broker, { projectId: PROJECT_ID, runId: requested.run.id })

      const finished = await waitFor(async () => {
        const run = await sixb.storage.agents?.runs.getById({ projectId: PROJECT_ID, id: child.id })
        return run && run.status !== "running" ? run : undefined
      })
      // A cancel is not a failure: the child stopped because its parent did.
      //
      // This is a characterization test, not a guard on one line: the finalize comes from
      // `runAgentTurn`'s own cancel path, and it still passes if the tool's catch block is removed,
      // if its recorded status is hard-coded, or if `parentSignal` is dropped from the child's
      // abort sources (the AI SDK forwards its own signal into `execute`). It is here because the
      // end-to-end outcome matters and nothing else covers it — an in-process child has no queue
      // job, so a leak on this path would never be reclaimed.
      expect(finished.status).toBe("cancelled")

      // The child must not be left holding its thread. Nothing else reclaims an in-process child,
      // so a thread pinned here would stay pinned for the life of the project.
      const thread = await sixb.storage.agents?.threads.getById({
        projectId: PROJECT_ID,
        id: child.threadId,
      })
      expect(thread?.activeRunId).toBeNull()
    } finally {
      await worker.stop()
    }
  })
})
