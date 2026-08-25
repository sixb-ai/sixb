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
import { createTestSixb } from "@sixb/core/testing"
import { convertArrayToReadableStream, MockLanguageModelV4 } from "ai/test"
import { AgentWorker } from "../src"
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

/** Storage whose Agent-run finalize is permanently unavailable for one target agent's runs. */
function withUnfinalizableChildRuns(storage: InMemoryStorage, agentId: string): InMemoryStorage {
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

function buildHost(input: {
  readonly mainModel: LanguageModelV4
  readonly specialistModel: LanguageModelV4
  readonly sandboxes: SandboxFactory
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
    broker: new InMemoryBroker(),
    storage: input.storage ?? new InMemoryStorage(),
    lakeStorage: new InMemoryLakeStorage(),
    blobStorage: new InMemoryBlobStorage(),
    queues: new InMemoryQueues(),
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

describe("sub_agent delegation failure", () => {
  test("does not report a child whose finalize was lost as an answer", async () => {
    const storage = withUnfinalizableChildRuns(new InMemoryStorage(), "researcher")
    const sixb = buildHost({
      mainModel: delegatingModel("researcher"),
      specialistModel: new MockLanguageModelV4({
        modelId: "specialist-model",
        doStream: async () => stream(answer("Invoices are late.")),
      }),
      sandboxes: new CountingSandboxFactory(),
      storage,
    })

    const requested = await requestMainTurn(sixb, ["agent-users"])
    const worker = new AgentWorker(sixb, {
      apiBaseUrl: API_BASE_URL,
      idlePollMs: 5,
      skillsDir: false,
    })
    await worker.start()
    try {
      // Settle on whichever happens first: the delegating run is redelivered (the fix — its job is
      // left for a later delivery to finalize), or it finalizes on its own (the regression).
      await waitFor(
        async () => {
          const parent = await sixb.storage.agents?.runs.getById({
            projectId: PROJECT_ID,
            id: requested.run.id,
          })
          if (!parent) return undefined
          return parent.attempt >= 2 || parent.status === "succeeded" ? parent : undefined
          // Redelivery waits out FINALIZE_RETRY_BACKOFF_MS (5s), so this needs more than the default.
        },
        { timeoutMs: 15_000, label: "delegating run redelivered or finalized" }
      )
    } finally {
      await worker.stop()
    }

    // The child did the work but its finalize could not be recorded. A thrown tool error becomes
    // tool-result text, so without `assertToolsHealthy` the delegating turn would sail past it and
    // finalize `succeeded` — permanently recording the opposite of what happened.
    const parent = await sixb.storage.agents?.runs.getById({
      projectId: PROJECT_ID,
      id: requested.run.id,
    })
    // The delegating turn must not ack a delivery whose child finalize was lost: its job is left
    // for redelivery, which shows up as a second attempt. Without `assertToolsHealthy` the thrown
    // error is swallowed into tool-result text, the turn finalizes on attempt 1, and the lost child
    // is silently reported to the user as an answer.
    expect(parent?.attempt).toBeGreaterThanOrEqual(2)
  }, 30_000) // That silence is why this lives in the e2e lane rather than the unit suite. // The delegating job is left for redelivery, which waits out FINALIZE_RETRY_BACKOFF_MS (5s).
})
