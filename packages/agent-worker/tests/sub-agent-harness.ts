/**
 * Shared fixtures for the `sub_agent` unit and e2e suites.
 *
 * Both drive a real `AgentWorker` over the same host wiring; keeping one copy means a
 * change to that wiring cannot leave one suite passing against stale setup.
 */
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
import { createTestSixb } from "@sixb/core/testing"
import { convertArrayToReadableStream, MockLanguageModelV4 } from "ai/test"
import { AgentWorker } from "../src"
import { waitFor } from "./helpers"

export const PROJECT_ID = "sub-agent-tool-tests"
export const API_BASE_URL = "http://localhost:3002/api/"
export const REQUESTER: Principal = { type: "user", id: "usr_requester" }

const USAGE: LanguageModelV4Usage = {
  inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 7, text: 7, reasoning: 0 },
  raw: { input_tokens: 10, output_tokens: 7 },
}

export function stream(chunks: LanguageModelV4StreamPart[]) {
  return { stream: convertArrayToReadableStream(chunks) }
}

export function finish(unified: "stop" | "tool-calls"): LanguageModelV4StreamPart {
  return { type: "finish", finishReason: { unified, raw: unified }, usage: USAGE }
}

export function answer(text: string): LanguageModelV4StreamPart[] {
  return [
    { type: "stream-start", warnings: [] },
    { type: "text-start", id: "t" },
    { type: "text-delta", id: "t", delta: text },
    { type: "text-end", id: "t" },
    finish("stop"),
  ]
}

/** Delegates on its first call, then reports what came back. Stateful for per-call ordering. */
export function delegatingModel(target: string): MockLanguageModelV4 {
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

export class StubSandbox implements Sandbox {
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

export class CountingSandboxFactory implements SandboxFactory {
  readonly sandboxes: StubSandbox[] = []
  async create(_options: CreateSandboxOptions = {}): Promise<Sandbox> {
    const sandbox = new StubSandbox()
    this.sandboxes.push(sandbox)
    return sandbox
  }
}

/** Storage whose Agent-run finalize is permanently unavailable for one target agent's runs. */
export function withUnfinalizableChildRuns(
  storage: InMemoryStorage,
  agentId: string
): InMemoryStorage {
  const agents = storage.agents
  if (!agents) throw new Error("expected agent storage")
  const wrapRuns = (runs: typeof agents.runs): typeof agents.runs =>
    new Proxy(runs, {
      get(target, property, receiver) {
        if (property === "finish") {
          return async (input: Parameters<typeof target.finish>[0]) => {
            const run = await target.getById({ projectId: input.projectId, id: input.id })
            if (run?.agentId === agentId) {
              throw new Error("storage unavailable")
            }
            return target.finish(input)
          }
        }
        const value = Reflect.get(target, property, receiver)
        return typeof value === "function" ? value.bind(target) : value
      },
    })
  const wrapAgents = (source: NonNullable<InMemoryStorage["agents"]>) =>
    new Proxy(source, {
      get(target, property, receiver) {
        if (property === "runs") return wrapRuns(target.runs)
        const value = Reflect.get(target, property, receiver)
        return typeof value === "function" ? value.bind(target) : value
      },
    })
  return new Proxy(storage, {
    get(target, property, receiver) {
      if (property === "agents") {
        const source = Reflect.get(target, property, receiver)
        return source ? wrapAgents(source) : source
      }
      if (property === "transaction") {
        return async (fn: (tx: unknown) => unknown) =>
          target.transaction(async (tx) =>
            fn(
              new Proxy(tx, {
                get(txTarget, txProperty, txReceiver) {
                  if (txProperty === "agents") {
                    const source = Reflect.get(txTarget, txProperty, txReceiver)
                    return source ? wrapAgents(source) : source
                  }
                  const value = Reflect.get(txTarget, txProperty, txReceiver)
                  return typeof value === "function" ? value.bind(txTarget) : value
                },
              })
            )
          )
      }
      const value = Reflect.get(target, property, receiver)
      return typeof value === "function" ? value.bind(target) : value
    },
  }) as InMemoryStorage
}

const agentUsers = defineGroup("agent-users", { label: "Agent users" })
const specialists = defineGroup("specialists", { label: "Specialists" })

/** Records every job id ever published to the agent queue, not just what is still claimable. */
export function recordingQueues(enqueued: string[]): InMemoryQueues {
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

export function buildHost(input: {
  readonly mainModel: LanguageModelV4
  readonly specialistModel: LanguageModelV4
  readonly sandboxes: SandboxFactory
  readonly queues?: InMemoryQueues
  readonly broker?: InMemoryBroker
  readonly storage?: InMemoryStorage
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
    storage: input.storage ?? new InMemoryStorage(),
    lakeStorage: new InMemoryLakeStorage(),
    blobStorage: new InMemoryBlobStorage(),
    queues: input.queues ?? new InMemoryQueues(),
    sandboxes: input.sandboxes,
  })
}

/** Request a main-agent turn the way a real signed-in request does: groups in, grants resolved. */
export async function requestMainTurn(
  sixb: ReturnType<typeof buildHost>,
  groupIds: readonly string[]
) {
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

export async function runWorkerUntilIdle(sixb: ReturnType<typeof buildHost>, runId: string) {
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
