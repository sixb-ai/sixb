import { describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { AGENT_MESSAGE_CONTENT_VERSION } from "../agents/message"
import { projectAgentThreadModelContext } from "../agents/thread-context-projection"
import type { Principal } from "../auth"
import type { FileRef } from "../blob-storage/types"
import type { SixbFailure } from "../errors/types"
import {
  type AddAgentThreadParticipantsInput,
  type AgentComputerSessionRecord,
  type AgentRunExecution,
  type AgentRunFailureCode,
  type AgentStorage,
  AgentStorageError,
  type AgentStorageErrorCode,
  type AgentThreadParticipantRecord,
  type ConversationAgentRunSpec,
  type CreateAgentContextCheckpointInput,
  type CreateAgentRunInput,
  type CreateAgentThreadInput,
  type CreateSubagentRunInput,
  type ForkAgentThreadInput,
  type ListAgentThreadChildrenInput,
  type StartAgentRunInput,
} from "../storage/agents"
import type { AuthStorage } from "../storage/auth"
import type { ExecutionStorage } from "../storage/executions"
import type { Storage } from "../storage/types"
import { createTestAgentExecution } from "./agent-execution"

export interface AgentStorageContractStorage extends Pick<Storage, "transaction"> {
  readonly agents: AgentStorage
  readonly auth: AuthStorage
  readonly executions: ExecutionStorage
}

export interface AgentStorageContractSuiteOptions<
  TStorage extends AgentStorageContractStorage = AgentStorageContractStorage,
> {
  /** Factory that produces a fresh storage bundle for each test case. */
  readonly createStorage: () => TStorage | Promise<TStorage>
  /** Optional cleanup invoked after every test case. */
  readonly teardown?: (storage: TStorage) => void | Promise<void>
}

const projectId = "project-a"
const otherProjectId = "project-b"
const owner: Principal = { type: "user", id: "usr_1" }
const otherUser: Principal = { type: "user", id: "usr_2" }
const serviceAccount: Extract<Principal, { readonly type: "serviceAccount" }> = {
  type: "serviceAccount",
  id: "svc_agent_sales",
}

function failure(
  message: string,
  at: string,
  code: AgentRunFailureCode = "internal.unexpected"
): SixbFailure<AgentRunFailureCode> {
  return { code, message, retryable: false, at }
}

const laptop = { id: "cmp_laptop", name: "Anthony's MacBook Pro", folder: "/Users/anthony/sixb" }

function at(value: string): Date {
  return new Date(value)
}

async function expectAgentError(
  promise: Promise<unknown>,
  code: AgentStorageErrorCode
): Promise<void> {
  await expect(promise).rejects.toBeInstanceOf(AgentStorageError)
  await expect(promise).rejects.toMatchObject({ code })
}

function threadInput(overrides: Partial<CreateAgentThreadInput> = {}): CreateAgentThreadInput {
  return {
    id: "thr_1",
    projectId,
    ownerPrincipal: owner,
    createdAt: at("2026-06-23T10:00:00.000Z"),
    ...overrides,
  }
}

function participantsInput(
  userIds: readonly string[],
  addedAt = at("2026-06-23T11:00:00.000Z")
): AddAgentThreadParticipantsInput {
  return {
    projectId,
    threadId: "thr_1",
    principals: userIds.map((id) => ({ type: "user", id })),
    addedBy: owner,
    maxParticipants: 10,
    addedAt,
  }
}

function participant(userId: string, addedAt: Date): AgentThreadParticipantRecord {
  return {
    projectId,
    threadId: "thr_1",
    principal: { type: "user", id: userId },
    addedAt,
    addedBy: owner,
  }
}

function execution(
  token: string,
  queueLeaseExpiresAt = at("2026-06-23T10:05:00.000Z")
): AgentRunExecution {
  return { token, queueLeaseExpiresAt }
}

type TestRunInput = CreateAgentRunInput &
  Omit<StartAgentRunInput, "id" | "projectId"> & {
    readonly id: string
    readonly projectId: string
  }

function runInput(overrides: Partial<TestRunInput> = {}): TestRunInput {
  const input = {
    id: "run_1",
    projectId,
    threadId: "thr_1",
    triggerMessageId: "msg_user_1",
    spec: { model: { provider: "test", modelId: "large" } },
    executionId: "test_agent_execution:run_1",
    execution: execution("exec_1"),
    createdAt: at("2026-06-23T10:00:10.000Z"),
    ...overrides,
  }
  return {
    ...input,
    executionId: overrides.executionId ?? `test_agent_execution:${input.id}`,
  }
}

/** A content-addressed reference, as blob storage returns it. */
function testFileRef(fileName: string): FileRef {
  const hex = createHash("sha256").update(fileName).digest("hex")
  return {
    blobId: `blob_${hex}`,
    digest: `sha256:${hex}`,
    sizeBytes: 12,
    fileName,
    mediaType: "text/csv",
  }
}

function subagentInput(
  parentExecutionToken: string,
  overrides: Partial<CreateSubagentRunInput> = {}
): CreateSubagentRunInput {
  const id = overrides.id ?? "child_1"
  return {
    id,
    projectId,
    executionId: overrides.executionId ?? `test_agent_execution:${id}`,
    parentRunId: "parent_1",
    parentExecutionToken,
    spawnKey: "research-orders",
    spec: {
      model: { provider: "test", modelId: "small" },
      reasoning: "medium",
      task: "Research the open orders.",
      toolNames: ["search_orders"],
      files: [{ path: "reports/orders.csv", fileRef: testFileRef("orders.csv") }],
    },
    thread: { id: `thread_${id}`, create: true },
    trigger: { id: `task_${id}`, parts: [{ type: "text", text: "Research the open orders." }] },
    maxActiveChildren: 4,
    createdAt: at("2026-06-23T10:01:00.000Z"),
    ...overrides,
  }
}

async function createRunningParent(
  storage: AgentStorage,
  fixture: AgentStorageContractStorage
): Promise<void> {
  await storage.threads.create(threadInput({ id: "parent_thread" }))
  const parent = runInput({
    id: "parent_1",
    threadId: "parent_thread",
    execution: execution("parent_token"),
  })
  await createTestAgentExecution(fixture, {
    projectId,
    runId: parent.id,
    executionId: parent.executionId,
    authority: "inherited",
  })
  await storage.runs.create(parent)
  await storage.runs.start({
    projectId,
    id: parent.id,
    modelId: "large",
    execution: parent.execution,
  })
}

async function createSubagent(
  storage: AgentStorage,
  fixture: AgentStorageContractStorage,
  overrides: Partial<CreateSubagentRunInput> = {}
) {
  const input = subagentInput("parent_token", overrides)
  const parent = await storage.runs.getById({ projectId: input.projectId, id: input.parentRunId })
  if (!parent || parent.kind !== "conversation") throw new Error("Expected child parent fixture")
  await createTestAgentExecution(fixture, {
    projectId: input.projectId,
    runId: input.id,
    executionId: input.executionId,
    sourceExecutionId: parent.executionId,
    authority: "inherited",
  })
  return storage.runs.createSubagent(input)
}

function checkpointInput(
  overrides: Partial<CreateAgentContextCheckpointInput> = {}
): CreateAgentContextCheckpointInput {
  return {
    id: "checkpoint_1",
    projectId,
    threadId: "thr_1",
    createdByRunId: "run_2",
    expectedPreviousCheckpointId: null,
    expectedHeadSeq: 3,
    executionToken: "exec_2",
    reason: "threshold",
    summary: "The user asked for one and the agent answered two.",
    summaryFormatVersion: 1,
    summarizedThroughSeq: 2,
    observedHeadSeq: 3,
    estimatedInputTokensBefore: 1_000,
    estimatedInputTokensAfter: 300,
    summaryModelId: "test-model",
    createdAt: at("2026-06-23T10:03:00.000Z"),
    ...overrides,
  }
}

async function createAndStartRun(
  storage: AgentStorage,
  fixture: AgentStorageContractStorage,
  input: TestRunInput
): Promise<Awaited<ReturnType<AgentStorage["runs"]["start"]>>> {
  await createRun(storage, fixture, input)
  return storage.runs.start({
    id: input.id,
    projectId: input.projectId,
    modelId: input.modelId,
    execution: input.execution,
    startedAt: input.startedAt,
  })
}

async function createRun(
  storage: AgentStorage,
  fixture: AgentStorageContractStorage,
  input: CreateAgentRunInput
) {
  await createTestAgentExecution(fixture, {
    projectId: input.projectId,
    runId: input.id,
    executionId: input.executionId,
    authority: "inherited",
  })
  return storage.runs.create(input)
}

async function prepareCheckpointCandidate(
  storage: AgentStorage,
  fixture: AgentStorageContractStorage
): Promise<void> {
  await storage.threads.create(threadInput())
  await storage.messages.append({
    id: "m1",
    projectId,
    threadId: "thr_1",
    runId: null,
    role: "user",
    parts: [{ type: "text", text: "one" }],
  })
  await createAndStartRun(storage, fixture, runInput({ id: "run_1" }))
  await storage.messages.append({
    id: "m2",
    projectId,
    threadId: "thr_1",
    runId: "run_1",
    role: "assistant",
    parts: [{ type: "text", text: "two" }],
  })
  await storage.runs.finish({
    id: "run_1",
    projectId,
    executionToken: "exec_1",
    status: "succeeded",
  })
  await storage.messages.append({
    id: "m3",
    projectId,
    threadId: "thr_1",
    runId: null,
    role: "user",
    parts: [{ type: "text", text: "three" }],
  })
  await createAndStartRun(
    storage,
    fixture,
    runInput({ id: "run_2", triggerMessageId: "m3", execution: execution("exec_2") })
  )
}

const forkedFile = {
  blobId: "blob_report",
  digest: `sha256:${"a".repeat(64)}`,
  sizeBytes: 12,
  fileName: "report.csv",
  mediaType: "text/csv",
} as const

function forkInput(overrides: Partial<ForkAgentThreadInput> = {}): ForkAgentThreadInput {
  return {
    projectId,
    sourceThreadId: "thr_1",
    id: "thr_fork",
    ownerPrincipal: otherUser,
    title: "Slipped deals",
    createdAt: at("2026-06-23T11:00:00.000Z"),
    ...overrides,
  }
}

/**
 * Two finished turns, then a third still running, each compacted by the run that follows:
 * `checkpoint_1` (written by finished `run_2`) and `checkpoint_2` (written by running `run_3`,
 * anchored on its trigger `m5`).
 */
async function prepareForkSource(
  storage: AgentStorage,
  fixture: AgentStorageContractStorage,
  /** The summary of the checkpoint the third turn writes. */
  summary = "Three deals slipped; Acme waits on legal review."
): Promise<void> {
  await storage.threads.create(threadInput({ title: "Slipped deals" }))
  await storage.messages.append({
    id: "m1",
    projectId,
    threadId: "thr_1",
    runId: null,
    role: "user",
    authorPrincipal: owner,
    parts: [
      { type: "text", text: "Which deals slipped?" },
      { type: "file", fileRef: forkedFile },
    ],
    metadata: { source: "chat" },
    createdAt: at("2026-06-23T10:00:01.000Z"),
  })
  await createAndStartRun(storage, fixture, runInput({ id: "run_1", triggerMessageId: "m1" }))
  await storage.messages.append({
    id: "m2",
    projectId,
    threadId: "thr_1",
    runId: "run_1",
    role: "assistant",
    authorPrincipal: owner,
    parts: [
      { type: "step-start" },
      {
        type: "tool-call",
        toolCallId: "call_1",
        toolName: "bash",
        input: { cmd: "report" },
        state: "output-available",
        output: { file: forkedFile },
      },
      { type: "text", text: "Three deals slipped." },
    ],
    createdAt: at("2026-06-23T10:00:02.000Z"),
    completedAt: at("2026-06-23T10:00:03.000Z"),
  })
  await storage.runs.finish({
    id: "run_1",
    projectId,
    executionToken: "exec_1",
    status: "succeeded",
  })

  await storage.messages.append({
    id: "m3",
    projectId,
    threadId: "thr_1",
    runId: null,
    role: "user",
    authorPrincipal: owner,
    parts: [{ type: "text", text: "Why did Acme slip?" }],
    createdAt: at("2026-06-23T10:00:04.000Z"),
  })
  await createAndStartRun(
    storage,
    fixture,
    runInput({ id: "run_2", triggerMessageId: "m3", execution: execution("exec_2") })
  )
  await storage.checkpoints.create(checkpointInput())
  await storage.messages.append({
    id: "m4",
    projectId,
    threadId: "thr_1",
    runId: "run_2",
    role: "assistant",
    parts: [{ type: "text", text: "Legal review." }],
    createdAt: at("2026-06-23T10:00:05.000Z"),
  })
  await storage.runs.finish({
    id: "run_2",
    projectId,
    executionToken: "exec_2",
    status: "succeeded",
  })

  await storage.messages.append({
    id: "m5",
    projectId,
    threadId: "thr_1",
    runId: null,
    role: "user",
    parts: [{ type: "text", text: "Draft the emails." }],
    createdAt: at("2026-06-23T10:00:06.000Z"),
  })
  await createAndStartRun(
    storage,
    fixture,
    runInput({ id: "run_3", triggerMessageId: "m5", execution: execution("exec_3") })
  )
  await storage.checkpoints.create(
    checkpointInput({
      id: "checkpoint_2",
      createdByRunId: "run_3",
      expectedPreviousCheckpointId: "checkpoint_1",
      expectedHeadSeq: 5,
      executionToken: "exec_3",
      summary,
      summarizedThroughSeq: 4,
      observedHeadSeq: 5,
      createdAt: at("2026-06-23T10:05:00.000Z"),
    })
  )
}

/**
 * Runs the shared `AgentStorage` contract against any storage implementation.
 *
 * This is the storage-independent specification for Sixb agent persistence: thread lifecycle and
 * project isolation, single-flight run reservation, execution reclaim, run finalization with
 * execution metadata, message append with thread-stats bookkeeping, and fenced context checkpoints.
 */
export function runAgentStorageContractSuite<TStorage extends AgentStorageContractStorage>(
  label: string,
  options: AgentStorageContractSuiteOptions<TStorage>
): void {
  const withStorage = async (
    body: (storage: AgentStorage, fixture: TStorage) => Promise<void>
  ): Promise<void> => {
    const fixture = await options.createStorage()
    try {
      await body(fixture.agents, fixture)
    } finally {
      await options.teardown?.(fixture)
    }
  }

  describe(label, () => {
    test("replaces lost state only under its current execution fence", async () => {
      // Regression proof: remove replace's name/owner guards; the stale attempts succeed.
      await withStorage(async (storage, fixture) => {
        await storage.threads.create(threadInput({ sandboxParams: {} }))
        const run = runInput({ execution: execution("first", new Date("2099-01-01")) })
        await createAndStartRun(storage, fixture, run)
        const acquire = {
          projectId,
          id: "thr_1",
          action: "acquire" as const,
          runId: run.id,
          executionToken: "first",
          name: "name-1",
          sourceFingerprint: "a".repeat(64),
        }
        await storage.threads.transitionSandbox(acquire)
        const replace = { ...acquire, action: "replace" as const, nextName: "name-2" }
        await expectAgentError(storage.threads.transitionSandbox(replace), "invalid_state")
        await storage.threads.transitionSandbox({
          ...acquire,
          action: "settle",
          status: "ready",
          initialized: true,
        })
        await expectAgentError(storage.threads.transitionSandbox(replace), "invalid_state")
        await storage.threads.transitionSandbox(acquire)
        for (const nextName of ["name-1", "../invalid", ""]) {
          await expectAgentError(
            storage.threads.transitionSandbox({ ...replace, nextName }),
            "invalid_state"
          )
        }
        await expectAgentError(
          storage.threads.transitionSandbox({ ...replace, executionToken: "stale" }),
          "execution_lost"
        )
        const replacement = await storage.threads.transitionSandbox(replace)
        const resetAt = replacement.resetAt
        expect(replacement).toMatchObject({
          name: "name-2",
          status: "busy",
          initialized: false,
          owner: { runId: run.id, executionToken: "first" },
          sourceFingerprint: acquire.sourceFingerprint,
          resetAt: expect.any(String),
        })
        await expectAgentError(storage.threads.transitionSandbox(replace), "invalid_state")
        await expectAgentError(
          storage.threads.transitionSandbox({
            ...acquire,
            action: "settle",
            status: "ready",
            initialized: true,
          }),
          "invalid_state"
        )
        await storage.threads.transitionSandbox({
          ...acquire,
          name: "name-2",
          action: "settle",
          status: "ready",
          initialized: true,
        })
        const resumed = await storage.threads.transitionSandbox({
          ...acquire,
          name: "name-2",
        })
        expect(resumed.resetAt).toBe(resetAt)
        expect((await storage.threads.getById({ projectId, id: "thr_1" }))?.sandboxState).toEqual(
          resumed
        )
      })
    })

    test("fences workspace ownership across reclamation and explicit recreation", async () => {
      // Regression proof: remove the busy-state or owner-token checks in transitionAgentThreadSandbox.
      await withStorage(async (storage, fixture) => {
        await storage.threads.create(threadInput({ sandboxParams: {} }))
        const input = runInput({ execution: execution("first", new Date("2099-01-01")) })
        await createTestAgentExecution(fixture, {
          projectId,
          runId: input.id,
          executionId: input.executionId,
          authority: "inherited",
        })
        await storage.runs.create(input)
        await storage.runs.start(input)
        const acquire = {
          projectId,
          id: "thr_1",
          action: "acquire" as const,
          runId: input.id,
          executionToken: "first",
          name: "name-1",
          sourceFingerprint: "a".repeat(64),
        }
        const attempts = await Promise.allSettled([
          storage.threads.transitionSandbox(acquire),
          storage.threads.transitionSandbox(acquire),
        ])
        expect(attempts.filter((attempt) => attempt.status === "fulfilled")).toHaveLength(1)
        expect(
          (await storage.threads.getById({ projectId, id: "thr_1" }))?.sandboxState
        ).toMatchObject({ status: "busy", initialized: false })
        await expectAgentError(storage.threads.transitionSandbox(acquire), "invalid_state")
        await storage.runs.reclaim({
          projectId,
          id: input.id,
          execution: execution("second", new Date("2099-01-01")),
        })
        await expectAgentError(
          storage.threads.transitionSandbox({
            ...acquire,
            executionToken: "second",
          }),
          "invalid_state"
        )
        await expectAgentError(
          storage.threads.transitionSandbox({
            ...acquire,
            action: "settle",
            status: "ready",
            initialized: true,
          }),
          "execution_lost"
        )
        const recreate = {
          projectId,
          id: "thr_1",
          action: "recreate" as const,
          expectedSandboxName: "name-1",
          name: "name-2",
        }
        await expectAgentError(storage.threads.transitionSandbox(recreate), "invalid_state")
        await storage.runs.finish({
          projectId,
          id: input.id,
          executionToken: "second",
          status: "failed",
        })
        expect(await storage.threads.transitionSandbox(recreate)).toEqual({
          name: "name-2",
          status: "new",
          initialized: false,
          resetAt: expect.any(String),
        })
        await expectAgentError(storage.threads.transitionSandbox(recreate), "invalid_state")
      })
    })

    test("resumes only confirmed workspace state with the pinned source", async () => {
      await withStorage(async (storage, fixture) => {
        await storage.threads.create(threadInput({ sandboxParams: {} }))
        const input = runInput({ execution: execution("owner", new Date("2099-01-01")) })
        await createTestAgentExecution(fixture, {
          projectId,
          runId: input.id,
          executionId: input.executionId,
          authority: "inherited",
        })
        await storage.runs.create(input)
        await storage.runs.start(input)
        const acquire = {
          projectId,
          id: "thr_1",
          action: "acquire" as const,
          runId: input.id,
          executionToken: "owner",
          name: "name",
          sourceFingerprint: "b".repeat(64),
        }
        await storage.threads.transitionSandbox(acquire)
        await storage.threads.transitionSandbox({
          ...acquire,
          action: "settle",
          status: "ready",
          initialized: true,
        })
        await expectAgentError(
          storage.threads.transitionSandbox({
            ...acquire,
            sourceFingerprint: "c".repeat(64),
          }),
          "invalid_state"
        )
        expect(await storage.threads.transitionSandbox(acquire)).toMatchObject({
          status: "busy",
          initialized: true,
        })
      })
    })

    test("snapshots workspace bindings without accepting runtime state or credentials", async () => {
      // Regression proof: remove snapshotAgentThreadSandboxParams from a provider's thread create.
      await withStorage(async (storage) => {
        const sandboxParams = { clientId: "acme", nested: { branch: "main" } }
        const record = await storage.threads.create(threadInput({ sandboxParams }))
        sandboxParams.nested.branch = "changed"
        const read = await storage.threads.getById({ projectId, id: record.id })
        expect(read?.sandboxParams).toEqual({ clientId: "acme", nested: { branch: "main" } })
        const mutable = record.sandboxParams?.nested
        if (mutable && typeof mutable === "object" && !Array.isArray(mutable))
          mutable.branch = "tampered"
        expect((await storage.threads.list({ projectId })).threads[0]?.sandboxParams).toEqual(
          read?.sandboxParams
        )
        await expectAgentError(
          storage.threads.create(
            threadInput({
              id: "unsafe",
              // @ts-expect-error storage requires a JSON object
              sandboxParams: [],
            })
          ),
          "invalid_input"
        )
        await expectAgentError(
          storage.threads.create(
            threadInput({
              id: "non-json",
              // @ts-expect-error storage accepts normalized JSON, not typed Dates
              sandboxParams: { at: new Date() },
            })
          ),
          "invalid_input"
        )
      })
    })

    test("keeps delimiter-containing project and sandbox thread ids distinct", async () => {
      // Regression proof: change the memory store key back to projectId + ":" + id.
      await withStorage(async (storage) => {
        await storage.threads.create(
          threadInput({ projectId: "a:b", id: "c", sandboxParams: { repo: "one" } })
        )
        await storage.threads.create(
          threadInput({ projectId: "a", id: "b:c", sandboxParams: { repo: "two" } })
        )
        expect(
          (await storage.threads.getById({ projectId: "a:b", id: "c" }))?.sandboxParams?.repo
        ).toBe("one")
        expect(
          (await storage.threads.getById({ projectId: "a", id: "b:c" }))?.sandboxParams?.repo
        ).toBe("two")
      })
    })
    // ── threads ───────────────────────────────────────────────────────────────────────────────

    test("creates threads, isolates projects, and rejects duplicate ids", async () => {
      await withStorage(async (storage) => {
        const thread = await storage.threads.create(threadInput({ title: "Q3 pipeline" }))
        expect(thread).toMatchObject({
          id: "thr_1",
          title: "Q3 pipeline",
          status: "active",
          activeRunId: null,
          messageCount: 0,
        })
        expect(thread.ownerPrincipal).toEqual(owner)

        await expectAgentError(storage.threads.create(threadInput()), "duplicate_id")

        // Same id under a different project is allowed and isolated.
        await expect(
          storage.threads.create(threadInput({ projectId: otherProjectId }))
        ).resolves.toMatchObject({ projectId: otherProjectId })
        await expect(storage.threads.getById({ projectId, id: "thr_1" })).resolves.toMatchObject({
          title: "Q3 pipeline",
        })
        await expect(
          storage.threads.getById({ projectId: "nope", id: "thr_1" })
        ).resolves.toBeNull()
      })
    })

    test("keeps a thread that runs on its owner's computer, and its turns' place", async () => {
      await withStorage(async (storage, fixture) => {
        const thread = await storage.threads.create(
          threadInput({ runsOn: "computer", computer: laptop })
        )
        expect(thread).toMatchObject({ runsOn: "computer", computer: laptop })
        await expect(storage.threads.getById({ projectId, id: thread.id })).resolves.toMatchObject({
          runsOn: "computer",
          computer: laptop,
        })
        const cloud = await storage.threads.create(threadInput({ id: "thr_cloud" }))
        expect(cloud).not.toHaveProperty("runsOn")
        expect(cloud).not.toHaveProperty("computer")

        // A computer's thread says where it runs; a cloud thread names no computer.
        await expectAgentError(
          storage.threads.create(threadInput({ id: "thr_nowhere", runsOn: "computer" })),
          "invalid_input"
        )
        await expectAgentError(
          storage.threads.create(threadInput({ id: "thr_mixed", computer: laptop })),
          "invalid_input"
        )
        await expectAgentError(
          storage.threads.create(
            threadInput({
              id: "thr_control",
              runsOn: "computer",
              computer: { ...laptop, folder: "/Users/anthony/\u001b[2Jsixb" },
            })
          ),
          "invalid_input"
        )

        const spec = { model: { provider: "test", modelId: "large" }, runsOn: "computer" as const }
        await createRun(storage, fixture, runInput({ id: "run_1", spec }))
        expect((await storage.runs.getById({ projectId, id: "run_1" }))?.spec).toEqual(spec)
        await expectAgentError(
          createRun(
            storage,
            fixture,
            runInput({
              id: "run_2",
              threadId: "thr_cloud",
              spec: { ...spec, runsOn: "laptop" } as unknown as ConversationAgentRunSpec,
            })
          ),
          "invalid_input"
        )
      })
    })

    // Guard proof: drop `movesComputerPlace` from a store's assignComputer; a rename on the same
    // folder records a move.
    test("moves a computer's thread to another computer or folder, and says when", async () => {
      await withStorage(async (storage) => {
        await storage.threads.create(threadInput({ runsOn: "computer", computer: laptop }))
        await storage.threads.create(threadInput({ id: "thr_cloud" }))
        const thread = { projectId, id: "thr_1" }

        // The same folder under a new name is no move.
        const renamed = await storage.threads.assignComputer({
          ...thread,
          computer: { ...laptop, name: "Work laptop" },
          movedAt: at("2026-06-23T11:00:00.000Z"),
        })
        expect(renamed.computer?.name).toBe("Work laptop")
        expect(renamed).not.toHaveProperty("movedAt")

        const elsewhere = { ...laptop, folder: "/Users/anthony/other" }
        await storage.threads.assignComputer({
          ...thread,
          computer: elsewhere,
          movedAt: at("2026-06-23T12:00:00.000Z"),
        })
        await expect(storage.threads.getById(thread)).resolves.toMatchObject({
          computer: elsewhere,
          movedAt: at("2026-06-23T12:00:00.000Z"),
        })

        await expectAgentError(
          storage.threads.assignComputer({ projectId, id: "thr_cloud", computer: laptop }),
          "invalid_input"
        )
        await expectAgentError(
          storage.threads.assignComputer({ projectId, id: "thr_none", computer: laptop }),
          "thread_not_found"
        )
        await expectAgentError(
          storage.threads.assignComputer({ ...thread, computer: { ...laptop, id: " " } }),
          "invalid_input"
        )
        expect(await storage.threads.getById({ projectId, id: "thr_cloud" })).not.toHaveProperty(
          "computer"
        )
      })
    })

    // Guard proof: drop the run update from a store's moveToCloud; the queued turn still names the
    // computer, so no worker takes it.
    test("moves a computer's thread to the cloud with its queued turn, never while one runs", async () => {
      await withStorage(async (storage, fixture) => {
        const spec = { model: { provider: "test", modelId: "large" }, runsOn: "computer" as const }
        await storage.threads.create(threadInput({ runsOn: "computer", computer: laptop }))
        await createRun(storage, fixture, runInput({ id: "run_1", spec }))

        const moved = await storage.threads.moveToCloud({
          projectId,
          id: "thr_1",
          movedAt: at("2026-06-23T12:00:00.000Z"),
        })
        expect(moved.thread).not.toHaveProperty("runsOn")
        expect(moved.thread).not.toHaveProperty("computer")
        expect(moved.thread.movedAt).toEqual(at("2026-06-23T12:00:00.000Z"))
        expect(moved.queued).toMatchObject({ id: "run_1", status: "queued" })
        expect(moved.queued?.spec).toEqual({ model: spec.model })
        expect((await storage.runs.getById({ projectId, id: "run_1" }))?.spec).toEqual({
          model: spec.model,
        })
        await expect(storage.threads.getById({ projectId, id: "thr_1" })).resolves.toEqual(
          moved.thread
        )
        await expectAgentError(
          storage.threads.moveToCloud({ projectId, id: "thr_1" }),
          "invalid_input"
        )

        // A turn running on the computer stays there, and so does its thread.
        await storage.threads.create(
          threadInput({ id: "thr_busy", runsOn: "computer", computer: laptop })
        )
        await createAndStartRun(
          storage,
          fixture,
          runInput({ id: "run_busy", threadId: "thr_busy", spec, execution: execution("busy") })
        )
        await expectAgentError(
          storage.threads.moveToCloud({ projectId, id: "thr_busy" }),
          "active_run_exists"
        )
        await expect(storage.threads.getById({ projectId, id: "thr_busy" })).resolves.toMatchObject(
          { runsOn: "computer", computer: laptop }
        )

        // An idle thread moves alone.
        await storage.threads.create(
          threadInput({ id: "thr_idle", runsOn: "computer", computer: laptop })
        )
        const idle = await storage.threads.moveToCloud({ projectId, id: "thr_idle" })
        expect(idle).not.toHaveProperty("queued")
        expect(idle.thread.movedAt).toBeInstanceOf(Date)

        await expectAgentError(
          storage.threads.moveToCloud({ projectId, id: "thr_none" }),
          "thread_not_found"
        )
      })
    })

    // Guard proof: drop `onComputer` from a store's start; the laptop starts the turn that moved
    // to the cloud, and the worker's run of it waits on a lease nobody gives back.
    test("starts a computer's turn only while it still runs on the computer", async () => {
      await withStorage(async (storage, fixture) => {
        const spec = { model: { provider: "test", modelId: "large" }, runsOn: "computer" as const }
        await storage.threads.create(threadInput({ runsOn: "computer", computer: laptop }))
        await createRun(storage, fixture, runInput({ id: "run_1", spec }))
        await storage.threads.moveToCloud({ projectId, id: "thr_1" })

        const start = (id: string, token: string) =>
          storage.runs.start({ projectId, id, execution: execution(token), onComputer: true })
        await expectAgentError(start("run_1", "laptop"), "invalid_state")
        expect((await storage.runs.getById({ projectId, id: "run_1" }))?.status).toBe("queued")

        await storage.threads.create(
          threadInput({ id: "thr_2", runsOn: "computer", computer: laptop })
        )
        await createRun(
          storage,
          fixture,
          runInput({ id: "run_2", threadId: "thr_2", spec, execution: execution("second") })
        )
        await expect(start("run_2", "second")).resolves.toMatchObject({ status: "running" })
      })
    })

    // Guard proof: drop assertTurnInThreadPlace from a store's create; a message asked for just
    // before its thread moved to the cloud makes a computer's turn nothing claims or dispatches.
    test("creates a turn only where its thread runs", async () => {
      await withStorage(async (storage, fixture) => {
        const model = { provider: "test", modelId: "large" }
        await storage.threads.create(threadInput({ runsOn: "computer", computer: laptop }))
        await storage.threads.create(threadInput({ id: "thr_cloud" }))

        await expectAgentError(
          createRun(storage, fixture, runInput({ id: "run_1", spec: { model } })),
          "invalid_state"
        )
        await expectAgentError(
          createRun(
            storage,
            fixture,
            runInput({ id: "run_2", threadId: "thr_cloud", spec: { model, runsOn: "computer" } })
          ),
          "invalid_state"
        )
        expect((await storage.threads.getById({ projectId, id: "thr_1" }))?.activeRunId).toBeNull()
      })
    })

    // Guard proof: drop the activeOnComputer filter from a store's list; every thread of the
    // owner comes back, idle or elsewhere.
    test("lists an owner's threads with a turn active on a computer, in a folder", async () => {
      await withStorage(async (storage, fixture) => {
        const spec = { model: { provider: "test", modelId: "large" }, runsOn: "computer" as const }
        const elsewhere = { ...laptop, folder: "/Users/anthony/other" }
        await storage.threads.create(threadInput({ runsOn: "computer", computer: laptop }))
        await storage.threads.create(
          threadInput({ id: "thr_idle", runsOn: "computer", computer: laptop })
        )
        await storage.threads.create(
          threadInput({ id: "thr_other", runsOn: "computer", computer: elsewhere })
        )
        await storage.threads.create(
          threadInput({
            id: "thr_theirs",
            ownerPrincipal: otherUser,
            runsOn: "computer",
            computer: laptop,
          })
        )
        await createRun(storage, fixture, runInput({ id: "run_1", spec }))
        await createRun(
          storage,
          fixture,
          runInput({ id: "run_2", threadId: "thr_other", spec, execution: execution("other") })
        )
        await createRun(
          storage,
          fixture,
          runInput({ id: "run_3", threadId: "thr_theirs", spec, execution: execution("theirs") })
        )

        const { threads } = await storage.threads.list({
          projectId,
          ownerPrincipal: owner,
          activeOnComputer: { computerId: laptop.id, folder: laptop.folder },
        })
        expect(threads.map((thread) => thread.id)).toEqual(["thr_1"])
      })
    })

    test("keeps each open sixb as a lease its owner renews and ends", async () => {
      await withStorage(async (storage) => {
        const now = at("2026-06-23T12:00:00.000Z")
        const live = at("2026-06-23T12:01:00.000Z")
        const session = (id: string, overrides: Partial<AgentComputerSessionRecord> = {}) => ({
          projectId,
          id,
          ownerPrincipal: owner,
          computer: laptop,
          expiresAt: live,
          ...overrides,
        })
        await storage.computers.hold(session("s_1"))
        await storage.computers.hold(
          session("s_2", { computer: { ...laptop, folder: "/Users/anthony/other" } })
        )
        await storage.computers.hold(session("s_3", { ownerPrincipal: otherUser }))
        await storage.computers.hold(session("s_4", { projectId: otherProjectId }))
        await storage.computers.hold(session("s_lapsed", { expiresAt: now }))

        const listed = await storage.computers.listLive({ projectId, ownerPrincipal: owner, now })
        expect(listed.map((each) => each.id)).toEqual(["s_1", "s_2"])
        expect(listed[0]).toEqual(session("s_1"))

        // A renewal moves its lease on.
        const later = at("2026-06-23T12:05:00.000Z")
        await storage.computers.hold(session("s_1", { expiresAt: later }))
        const renewed = await storage.computers.listLive({
          projectId,
          ownerPrincipal: owner,
          now: at("2026-06-23T12:02:00.000Z"),
        })
        expect(renewed.map((each) => each.id)).toEqual(["s_1"])

        // Only its owner ends it.
        await expect(
          storage.computers.release({ projectId, id: "s_1", ownerPrincipal: otherUser })
        ).resolves.toBeNull()
        await expect(
          storage.computers.release({ projectId, id: "s_1", ownerPrincipal: owner })
        ).resolves.toEqual(session("s_1", { expiresAt: later }))
        await expect(
          storage.computers.release({ projectId, id: "s_1", ownerPrincipal: owner })
        ).resolves.toBeNull()

        const lapsed = await storage.computers.removeLapsed({ projectId, now })
        expect(lapsed.map((each) => each.id)).toEqual(["s_lapsed"])
        await expect(storage.computers.removeLapsed({ projectId, now })).resolves.toEqual([])
        await expect(
          storage.computers.listLive({ projectId: otherProjectId, ownerPrincipal: owner, now })
        ).resolves.toEqual([session("s_4", { projectId: otherProjectId })])

        await expectAgentError(storage.computers.hold(session(" ")), "invalid_input")
        await expectAgentError(
          storage.computers.hold(session("s_5", { computer: { ...laptop, name: "a\u0007b" } })),
          "invalid_input"
        )
      })
    })

    test("reads several threads at once, in the order asked", async () => {
      await withStorage(async (storage) => {
        const first = await storage.threads.create(threadInput())
        const second = await storage.threads.create(threadInput({ id: "thr_2" }))
        await storage.threads.create(threadInput({ id: "thr_3", projectId: otherProjectId }))

        await expect(
          storage.threads.getByIds({ projectId, ids: ["thr_2", "missing", "thr_1", "thr_2"] })
        ).resolves.toEqual([second, first])
        await expect(storage.threads.getByIds({ projectId, ids: ["thr_3"] })).resolves.toEqual([])
        await expect(storage.threads.getByIds({ projectId, ids: [] })).resolves.toEqual([])
      })
    })

    test("lists threads with filters, ordering, and pagination", async () => {
      await withStorage(async (storage) => {
        await storage.threads.create(
          threadInput({ id: "thr_a", createdAt: at("2026-06-23T10:00:00.000Z") })
        )
        await storage.threads.create(
          threadInput({
            id: "thr_b",
            createdAt: at("2026-06-23T10:01:00.000Z"),
          })
        )
        await storage.threads.create(
          threadInput({
            id: "thr_c",
            status: "archived",
            createdAt: at("2026-06-23T10:02:00.000Z"),
          })
        )
        await storage.threads.create(threadInput({ id: "thr_other", projectId: otherProjectId }))

        const all = await storage.threads.list({ projectId, order: "asc" })
        expect(all.threads.map((thread) => thread.id)).toEqual(["thr_a", "thr_b", "thr_c"])
        expect(all.total).toBe(3)
        expect(all.hasMore).toBe(false)

        const active = await storage.threads.list({ projectId, statuses: ["active"], order: "asc" })
        expect(active.threads.map((thread) => thread.id)).toEqual(["thr_a", "thr_b"])

        const firstPage = await storage.threads.list({ projectId, order: "asc", limit: 2 })
        expect(firstPage.threads.map((thread) => thread.id)).toEqual(["thr_a", "thr_b"])
        expect(firstPage.hasMore).toBe(true)
        expect(firstPage.total).toBe(3)

        const secondPage = await storage.threads.list({
          projectId,
          order: "asc",
          limit: 2,
          offset: 2,
        })
        expect(secondPage.threads.map((thread) => thread.id)).toEqual(["thr_c"])
        expect(secondPage.hasMore).toBe(false)
      })
    })

    // ── participants ───────────────────────────────────────────────────────────────────────────

    test("adds participants once and keeps when and by whom they were first added", async () => {
      await withStorage(async (storage) => {
        await storage.threads.create(threadInput())

        const first = await storage.threads.addParticipants(
          participantsInput(["usr_cleo", "usr_bob"], at("2026-06-23T11:00:00.000Z"))
        )
        expect(first).toEqual([
          participant("usr_bob", at("2026-06-23T11:00:00.000Z")),
          participant("usr_cleo", at("2026-06-23T11:00:00.000Z")),
        ])

        const again = await storage.threads.addParticipants({
          ...participantsInput(["usr_cleo", "usr_dan"], at("2026-06-23T12:00:00.000Z")),
          addedBy: { type: "system", id: "system" },
        })
        expect(again).toEqual([
          participant("usr_bob", at("2026-06-23T11:00:00.000Z")),
          participant("usr_cleo", at("2026-06-23T11:00:00.000Z")),
          {
            ...participant("usr_dan", at("2026-06-23T12:00:00.000Z")),
            addedBy: { type: "system", id: "system" },
          },
        ])

        expect(
          await storage.threads.listParticipants({ projectId, threadIds: ["thr_1", "thr_1"] })
        ).toEqual(again)
      })
    })

    // Regression proof: compare ids with localeCompare in compareAgentThreadParticipants; it puts
    // "usr_a" before "usr_B", where PostgreSQL's "C" collation and SQLite put "usr_B" first.
    test("orders participants added at once by their ids' bytes, alike everywhere", async () => {
      await withStorage(async (storage) => {
        await storage.threads.create(threadInput())
        await storage.threads.create(threadInput({ id: "thr_2" }))
        for (const threadId of ["thr_2", "thr_1"]) {
          await storage.threads.addParticipants({
            ...participantsInput(["usr_a", "usr_B", "usr_é"]),
            threadId,
          })
        }

        const listed = await storage.threads.listParticipants({
          projectId,
          threadIds: ["thr_2", "thr_1"],
        })
        expect(listed.map((record) => `${record.principal.id}@${record.threadId}`)).toEqual([
          "usr_B@thr_1",
          "usr_B@thr_2",
          "usr_a@thr_1",
          "usr_a@thr_2",
          "usr_é@thr_1",
          "usr_é@thr_2",
        ])
      })
    })

    test("lets one of several adds racing for the last place win", async () => {
      // Concurrent calls rarely interleave here; the PostgreSQL suite holds a transaction open to
      // prove its row lock. This checks the outcome every provider must give.
      await withStorage(async (storage) => {
        await storage.threads.create(threadInput())
        await storage.threads.addParticipants(participantsInput(["usr_bob"]))

        const racers = ["usr_cleo", "usr_dan", "usr_eve", "usr_fay", "usr_gus"]
        const race = await Promise.allSettled(
          racers.map((id) =>
            storage.threads.addParticipants({ ...participantsInput([id]), maxParticipants: 2 })
          )
        )
        expect(race.filter((result) => result.status === "fulfilled")).toHaveLength(1)
        for (const result of race) {
          if (result.status === "rejected") {
            expect(result.reason).toMatchObject({ code: "participant_limit" })
          }
        }

        expect(
          await storage.threads.listParticipants({ projectId, threadIds: ["thr_1"] })
        ).toHaveLength(2)
      })
    })

    test("refuses participants past the limit, and missing threads", async () => {
      await withStorage(async (storage) => {
        await storage.threads.create(threadInput())
        await storage.threads.addParticipants(participantsInput(["usr_bob"]))

        // Regression proof: drop the limit check in participantsToAdd; the third user is added.
        await expectAgentError(
          storage.threads.addParticipants({
            ...participantsInput(["usr_cleo", "usr_dan"]),
            maxParticipants: 2,
          }),
          "participant_limit"
        )
        await expectAgentError(
          storage.threads.addParticipants({ ...participantsInput(["usr_bob"]), threadId: "nope" }),
          "thread_not_found"
        )

        // A refused add adds no one, and someone already there does not count twice.
        const kept = await storage.threads.addParticipants({
          ...participantsInput(["usr_bob", "usr_cleo"]),
          maxParticipants: 2,
        })
        expect(kept.map((record) => record.principal.id)).toEqual(["usr_bob", "usr_cleo"])
      })
    })

    test("removes a participant and lists the threads shared with a user", async () => {
      await withStorage(async (storage) => {
        await storage.threads.create(
          threadInput({ id: "thr_a", createdAt: at("2026-06-23T10:00:00.000Z") })
        )
        await storage.threads.create(
          threadInput({ id: "thr_b", createdAt: at("2026-06-23T10:01:00.000Z") })
        )
        await storage.threads.create(
          threadInput({ id: "thr_c", createdAt: at("2026-06-23T10:02:00.000Z") })
        )
        await storage.threads.create(threadInput({ id: "thr_a", projectId: otherProjectId }))
        for (const threadId of ["thr_a", "thr_c"]) {
          await storage.threads.addParticipants({ ...participantsInput(["usr_bob"]), threadId })
        }
        await storage.threads.addParticipants({
          ...participantsInput(["usr_bob"]),
          projectId: otherProjectId,
          threadId: "thr_a",
        })

        const bob = { type: "user", id: "usr_bob" } as const
        const shared = await storage.threads.list({
          projectId,
          participantPrincipal: bob,
          order: "asc",
        })
        expect(shared.threads.map((thread) => thread.id)).toEqual(["thr_a", "thr_c"])
        expect(shared.total).toBe(2)

        const page = await storage.threads.list({
          projectId,
          participantPrincipal: bob,
          order: "desc",
          limit: 1,
        })
        expect(page.threads.map((thread) => thread.id)).toEqual(["thr_c"])
        expect(page.hasMore).toBe(true)

        expect(
          await storage.threads.removeParticipant({ projectId, threadId: "thr_a", principal: bob })
        ).toBe(true)
        expect(
          await storage.threads.removeParticipant({ projectId, threadId: "thr_a", principal: bob })
        ).toBe(false)
        expect(
          await storage.threads.removeParticipant({ projectId, threadId: "nope", principal: bob })
        ).toBe(false)

        const after = await storage.threads.list({ projectId, participantPrincipal: bob })
        expect(after.threads.map((thread) => thread.id)).toEqual(["thr_c"])
        expect(
          await storage.threads.listParticipants({ projectId, threadIds: ["thr_a", "thr_b"] })
        ).toEqual([])
        expect(
          await storage.threads.listParticipants({
            projectId: otherProjectId,
            threadIds: ["thr_a"],
          })
        ).toHaveLength(1)
      })
    })

    test("rolls participants back with their transaction", async () => {
      await withStorage(async (storage, fixture) => {
        await storage.threads.create(threadInput())

        await expect(
          fixture.transaction(async (tx) => {
            await tx.agents?.threads.addParticipants(participantsInput(["usr_bob"]))
            throw new Error("rollback")
          })
        ).rejects.toThrow("rollback")

        expect(await storage.threads.listParticipants({ projectId, threadIds: ["thr_1"] })).toEqual(
          []
        )
      })
    })

    // ── durable queued runs ────────────────────────────────────────────────────────────────────

    test("creates a queued run before execution and claims the thread", async () => {
      await withStorage(async (storage, fixture) => {
        await storage.threads.create(threadInput())

        const queued = await createRun(storage, fixture, runInput({ id: "run_1" }))
        expect(queued).toMatchObject({
          status: "queued",
          attempt: 0,
          threadId: "thr_1",
          spec: { model: { provider: "test", modelId: "large" } },
        })
        expect(queued.execution).toBeUndefined()
        expect(queued.startedAt).toBeUndefined()
        await expect(storage.runs.list({ projectId, statuses: ["queued"] })).resolves.toMatchObject(
          {
            runs: [{ id: "run_1", status: "queued" }],
            total: 1,
          }
        )
        await expect(storage.threads.getById({ projectId, id: "thr_1" })).resolves.toMatchObject({
          activeRunId: "run_1",
        })

        const started = await storage.runs.start({
          projectId,
          id: "run_1",
          modelId: "test-model",
          execution: execution("exec_1"),
          startedAt: at("2026-06-23T10:01:00.000Z"),
        })
        expect(started).toMatchObject({ status: "running", attempt: 1, modelId: "test-model" })
        expect(started.execution).toEqual(execution("exec_1"))
        expect(started.executionId).toBe("test_agent_execution:run_1")
        expect(started.startedAt?.toISOString()).toBe("2026-06-23T10:01:00.000Z")
      })
    })

    test("keeps a turn's tier and the probabilities Sixb picked it from", async () => {
      await withStorage(async (storage, fixture) => {
        await storage.threads.create(threadInput())
        const spec = {
          model: { provider: "test", modelId: "large" },
          tier: "heavy" as const,
          tierProbabilities: { light: 0.05, standard: 0.25, heavy: 0.7 },
          reasoning: "high" as const,
        }

        await createRun(storage, fixture, runInput({ id: "run_1", spec }))
        expect((await storage.runs.getById({ projectId, id: "run_1" }))?.spec).toEqual(spec)

        // Proven by removal: drop the tier checks from assertConversationAgentRunSpec.
        for (const invalid of [
          { ...spec, tier: "medium" },
          { ...spec, tierProbabilities: { light: 0.3, standard: 0.7 } },
          { ...spec, tierProbabilities: { ...spec.tierProbabilities, heavy: 1.5 } },
        ]) {
          await expectAgentError(
            createRun(
              storage,
              fixture,
              runInput({ id: "run_2", spec: invalid as ConversationAgentRunSpec })
            ),
            "invalid_input"
          )
        }
      })
    })

    test("rejects a run whose durable execution does not match its Agent authority", async () => {
      await withStorage(async (storage, fixture) => {
        await storage.threads.create(threadInput())
        const executionId = await createTestAgentExecution(fixture, {
          projectId,
          actorId: "support",
          runId: "run_1",
        })

        await expectAgentError(
          storage.runs.create(runInput({ id: "run_1", executionId })),
          "invalid_input"
        )
        await expect(storage.threads.getById({ projectId, id: "thr_1" })).resolves.toMatchObject({
          activeRunId: null,
        })
      })
    })

    test("finishes a queued run and releases the thread", async () => {
      await withStorage(async (storage, fixture) => {
        await storage.threads.create(threadInput())
        await createRun(storage, fixture, runInput({ id: "run_1" }))

        const cancelled = await storage.runs.finishQueued({
          projectId,
          id: "run_1",
          status: "cancelled",
          error: failure(
            "Cancelled before execution",
            "2026-06-23T10:01:00.000Z",
            "runtime.cancelled"
          ),
          completedAt: at("2026-06-23T10:01:00.000Z"),
        })
        expect(cancelled).toMatchObject({
          status: "cancelled",
          attempt: 0,
          error: failure(
            "Cancelled before execution",
            "2026-06-23T10:01:00.000Z",
            "runtime.cancelled"
          ),
        })
        await expect(storage.threads.getById({ projectId, id: "thr_1" })).resolves.toMatchObject({
          activeRunId: null,
        })
        await expectAgentError(
          storage.runs.start({
            projectId,
            id: "run_1",
            execution: execution("exec_1"),
          }),
          "invalid_state"
        )

        await createRun(storage, fixture, runInput({ id: "run_2" }))
        await expect(
          storage.runs.finishQueued({
            projectId,
            id: "run_2",
            status: "failed",
            error: failure("Agent is unavailable", "2026-06-23T10:02:00.000Z"),
            completedAt: at("2026-06-23T10:02:00.000Z"),
          })
        ).resolves.toMatchObject({
          status: "failed",
          attempt: 0,
          error: failure("Agent is unavailable", "2026-06-23T10:02:00.000Z"),
        })
      })
    })

    // ── durable child runs ─────────────────────────────────────────────────────────────────────

    test("creates a child's thread, its task and its run at once, and replays them exactly", async () => {
      await withStorage(async (storage, fixture) => {
        await createRunningParent(storage, fixture)
        const input = subagentInput("parent_token")
        const child = await createSubagent(storage, fixture)

        expect(child).toMatchObject({
          kind: "subagent",
          id: "child_1",
          threadId: "thread_child_1",
          triggerMessageId: "task_child_1",
          parentRunId: "parent_1",
          spawnKey: "research-orders",
          status: "queued",
          attempt: 0,
          spec: input.spec,
        })
        await expect(storage.threads.getById({ projectId, id: "thread_child_1" })).resolves.toEqual(
          {
            id: "thread_child_1",
            projectId,
            kind: "subagent",
            parent: { threadId: "parent_thread", spawnedBy: "parent_1", key: "research-orders" },
            ownerPrincipal: owner,
            status: "active",
            activeRunId: "child_1",
            lastMessageAt: at("2026-06-23T10:01:00.000Z"),
            messageCount: 1,
            createdAt: at("2026-06-23T10:01:00.000Z"),
            updatedAt: at("2026-06-23T10:01:00.000Z"),
          }
        )
        const task = {
          id: "task_child_1",
          projectId,
          threadId: "thread_child_1",
          runId: "child_1",
          role: "user",
          seq: 1,
          parts: [{ type: "text", text: "Research the open orders." }],
          contentVersion: AGENT_MESSAGE_CONTENT_VERSION,
          createdAt: at("2026-06-23T10:01:00.000Z"),
        }
        await expect(
          storage.messages.list({ projectId, threadId: "thread_child_1" })
        ).resolves.toMatchObject({ messages: [task], total: 1 })

        // A replay writes nothing more, whatever trigger it brings.
        await expect(
          storage.runs.createSubagent({ ...input, trigger: { ...input.trigger, id: "other" } })
        ).resolves.toEqual(child)
        await expect(
          storage.messages.list({ projectId, threadId: "thread_child_1" })
        ).resolves.toMatchObject({ total: 1 })
        await expectAgentError(
          storage.runs.createSubagent({
            ...input,
            spec: { ...input.spec, task: "Research different orders." },
          }),
          "duplicate_id"
        )

        const listed = await storage.runs.list({
          projectId,
          kinds: ["subagent"],
          parentRunId: "parent_1",
        })
        expect(listed.runs.map((run) => run.id)).toEqual(["child_1"])
        await expect(
          storage.runs.list({ projectId, threadId: "thread_child_1" })
        ).resolves.toMatchObject({ runs: [{ id: "child_1" }], total: 1 })
        await expect(
          storage.runs.list({ projectId, kinds: ["conversation"] })
        ).resolves.toMatchObject({ runs: [{ id: "parent_1" }], total: 1 })
        await expect(
          storage.threads.getById({ projectId, id: "parent_thread" })
        ).resolves.toMatchObject({ activeRunId: "parent_1", messageCount: 0 })
      })
    })

    test("rolls a child's thread back with its run", async () => {
      await withStorage(async (storage, fixture) => {
        await createRunningParent(storage, fixture)
        const input = subagentInput("parent_token")
        await createTestAgentExecution(fixture, {
          projectId,
          runId: input.id,
          executionId: input.executionId,
          sourceExecutionId: "test_agent_execution:parent_1",
          authority: "inherited",
        })

        const rolledBack = await fixture
          .transaction(async (tx) => {
            await tx.agents?.runs.createSubagent(input)
            throw new Error("rollback")
          })
          .catch((error: unknown) => error)
        expect(rolledBack).toMatchObject({ message: "rollback" })

        await expect(storage.threads.getById({ projectId, id: "thread_child_1" })).resolves.toBe(
          null
        )
        await expect(storage.messages.getById({ projectId, id: "task_child_1" })).resolves.toBe(
          null
        )
        await expect(storage.runs.getById({ projectId, id: "child_1" })).resolves.toBe(null)
      })
    })

    test("keeps a sub-agent's workspace on its thread, fenced by the thread's active run", async () => {
      // Removal proofs: require `sandboxParams` again in transitionAgentThreadSandbox, and the
      // child's acquire is refused as unconfigured; fence on `run.kind === "conversation"` again,
      // and it is refused as lost; drop `startSubagentWorkspaceAgain`, and the destroyed
      // workspace cannot be started again.
      await withStorage(async (storage, fixture) => {
        await createRunningParent(storage, fixture)
        await createSubagent(storage, fixture)
        await storage.runs.start({
          projectId,
          id: "child_1",
          execution: execution("child_token", new Date("2099-01-01")),
        })
        const acquire = {
          projectId,
          id: "thread_child_1",
          action: "acquire" as const,
          runId: "child_1",
          executionToken: "child_token",
          name: "child-workspace",
          sourceFingerprint: "b".repeat(64),
        }

        // The turn it runs under does not own the child's thread.
        await expectAgentError(
          storage.threads.transitionSandbox({
            ...acquire,
            runId: "parent_1",
            executionToken: "parent_token",
          }),
          "execution_lost"
        )
        await expect(storage.threads.transitionSandbox(acquire)).resolves.toMatchObject({
          name: "child-workspace",
          status: "busy",
          owner: { runId: "child_1", executionToken: "child_token" },
        })
        await storage.threads.transitionSandbox({
          ...acquire,
          action: "settle",
          status: "ready",
          initialized: true,
        })
        await expect(
          storage.threads.getById({ projectId, id: "thread_child_1" })
        ).resolves.toMatchObject({
          sandboxState: { name: "child-workspace", status: "ready", initialized: true },
        })

        // A run that destroyed it, or left it unsaved, leaves the next a fresh one to start.
        await storage.threads.transitionSandbox(acquire)
        await storage.threads.transitionSandbox({
          ...acquire,
          action: "settle",
          status: "unavailable",
          initialized: true,
        })
        await expectAgentError(storage.threads.transitionSandbox(acquire), "invalid_state")
        await expect(
          storage.threads.transitionSandbox({ ...acquire, name: "child-workspace-2" })
        ).resolves.toEqual({
          name: "child-workspace-2",
          status: "busy",
          initialized: false,
          resetAt: expect.any(String),
          sourceFingerprint: acquire.sourceFingerprint,
          owner: { runId: "child_1", executionToken: "child_token" },
        })
      })
    })

    test("runs one child run at a time in its thread", async () => {
      // Removal proof: drop the active-run check on a child's thread; `child_2` is admitted while
      // `child_1` still runs.
      await withStorage(async (storage, fixture) => {
        await createRunningParent(storage, fixture)
        await createSubagent(storage, fixture)
        await storage.runs.start({
          projectId,
          id: "child_1",
          execution: execution("child_token"),
        })
        await storage.runs.finish({
          projectId,
          id: "parent_1",
          executionToken: "parent_token",
          status: "succeeded",
        })
        await createAndStartRun(
          storage,
          fixture,
          runInput({
            id: "parent_2",
            threadId: "parent_thread",
            triggerMessageId: "msg_user_2",
            execution: execution("parent_token_2"),
          })
        )
        const next = subagentInput("parent_token_2", {
          id: "child_2",
          parentRunId: "parent_2",
          thread: { id: "thread_child_1", create: false },
          trigger: { id: "trigger_child_2", parts: [{ type: "text", text: "Go on." }] },
          createdAt: at("2026-06-23T10:03:00.000Z"),
        })
        await createTestAgentExecution(fixture, {
          projectId,
          runId: next.id,
          executionId: next.executionId,
          sourceExecutionId: "test_agent_execution:parent_2",
          authority: "inherited",
        })

        await expectAgentError(storage.runs.createSubagent(next), "active_run_exists")
        await expectAgentError(
          storage.runs.createSubagent({ ...next, spawnKey: "another-child" }),
          "invalid_input"
        )
        await expectAgentError(
          storage.runs.createSubagent({ ...next, thread: { id: "missing", create: false } }),
          "thread_not_found"
        )
        await expectAgentError(
          storage.runs.createSubagent({ ...next, thread: { id: "thread_child_1", create: true } }),
          "duplicate_id"
        )

        await storage.runs.finish({
          projectId,
          id: "child_1",
          executionToken: "child_token",
          status: "succeeded",
          result: { text: "Three open orders." },
        })
        await expect(
          storage.threads.getById({ projectId, id: "thread_child_1" })
        ).resolves.toMatchObject({ activeRunId: null })

        await expect(storage.runs.createSubagent(next)).resolves.toMatchObject({
          id: "child_2",
          threadId: "thread_child_1",
          triggerMessageId: "trigger_child_2",
          parentRunId: "parent_2",
        })
        await expect(
          storage.threads.getById({ projectId, id: "thread_child_1" })
        ).resolves.toMatchObject({
          parent: { threadId: "parent_thread", spawnedBy: "parent_1", key: "research-orders" },
          activeRunId: "child_2",
          messageCount: 2,
          lastMessageAt: at("2026-06-23T10:03:00.000Z"),
        })
        const { messages } = await storage.messages.list({ projectId, threadId: "thread_child_1" })
        expect(messages.map(({ id, seq, runId }) => ({ id, seq, runId }))).toEqual([
          { id: "task_child_1", seq: 1, runId: "child_1" },
          { id: "trigger_child_2", seq: 2, runId: "child_2" },
        ])
      })
    })

    test("deletes a dead child run's messages whole, its trigger included", async () => {
      await withStorage(async (storage, fixture) => {
        await createRunningParent(storage, fixture)
        await createSubagent(storage, fixture)
        await storage.runs.start({ projectId, id: "child_1", execution: execution("child_token") })
        await storage.messages.append({
          id: "work_child_1",
          projectId,
          threadId: "thread_child_1",
          runId: "child_1",
          role: "assistant",
          parts: [{ type: "text", text: "Looking." }],
          createdAt: at("2026-06-23T10:02:00.000Z"),
        })

        await expect(
          storage.messages.deleteByRunId({
            projectId,
            threadId: "thread_child_1",
            runId: "child_1",
          })
        ).resolves.toBe(2)
        await expect(
          storage.threads.getById({ projectId, id: "thread_child_1" })
        ).resolves.toMatchObject({ messageCount: 0, lastMessageAt: undefined })
      })
    })

    test("never lists a child's thread", async () => {
      // Removal proof: drop the conversation filter from `threads.list`; the child's thread is
      // listed with its owner's conversations.
      await withStorage(async (storage, fixture) => {
        await createRunningParent(storage, fixture)
        await createSubagent(storage, fixture)
        // A participant of the conversation lists it among what is shared with them, alone.
        const reader = { type: "user", id: "usr_reader" } as const
        await storage.threads.addParticipants({
          ...participantsInput([reader.id]),
          threadId: "parent_thread",
        })

        for (const input of [
          {},
          { ownerPrincipal: owner },
          { participantPrincipal: reader },
          { statuses: ["active" as const] },
        ]) {
          await expect(storage.threads.list({ projectId, ...input })).resolves.toMatchObject({
            threads: [{ id: "parent_thread" }],
            total: 1,
          })
        }
      })
    })

    test("lists a conversation's sub-agent threads, oldest first, by the turn that spawned them", async () => {
      await withStorage(async (storage, fixture) => {
        await createRunningParent(storage, fixture)
        await createSubagent(storage, fixture, {
          id: "child_b",
          spawnKey: "b",
          createdAt: at("2026-06-23T10:02:00.000Z"),
        })
        await createSubagent(storage, fixture, {
          id: "child_a",
          spawnKey: "a",
          createdAt: at("2026-06-23T10:01:00.000Z"),
        })
        const children = (input: Partial<ListAgentThreadChildrenInput> = {}) =>
          storage.threads
            .listChildren({ projectId, parentThreadId: "parent_thread", ...input })
            .then((threads) => threads.map((thread) => thread.id))

        expect(await children()).toEqual(["thread_child_a", "thread_child_b"])
        expect(await children({ parentRunId: "parent_1" })).toEqual([
          "thread_child_a",
          "thread_child_b",
        ])
        expect(await children({ parentRunId: "parent_2" })).toEqual([])
        expect(await children({ limit: 1, offset: 1 })).toEqual(["thread_child_b"])
        expect(
          await storage.threads.listChildren({ projectId, parentThreadId: "thread_child_a" })
        ).toEqual([])
        expect(
          (await storage.threads.listChildren({ projectId, parentThreadId: "parent_thread" }))[0]
        ).toMatchObject({
          kind: "subagent",
          parent: { threadId: "parent_thread", spawnedBy: "parent_1", key: "a" },
        })
      })
    })

    test("keeps a child's thread out of what only a conversation does", async () => {
      await withStorage(async (storage, fixture) => {
        await createRunningParent(storage, fixture)
        await createSubagent(storage, fixture)

        await expectAgentError(
          storage.threads.fork(forkInput({ sourceThreadId: "thread_child_1" })),
          "thread_not_conversation"
        )
        await expectAgentError(
          storage.threads.addParticipants({
            ...participantsInput(["usr_bob"]),
            threadId: "thread_child_1",
          }),
          "thread_not_conversation"
        )
        await expectAgentError(
          createRun(
            storage,
            fixture,
            runInput({ id: "turn_in_child", threadId: "thread_child_1" })
          ),
          "thread_not_conversation"
        )

        // A fork of the conversation copies its messages, never its children's.
        const fork = await storage.threads.fork(forkInput({ sourceThreadId: "parent_thread" }))
        expect(fork).toMatchObject({ kind: "conversation", messageCount: 0 })
        expect(fork).not.toHaveProperty("parent")
        await expect(
          storage.threads.list({ projectId, ownerPrincipal: otherUser })
        ).resolves.toMatchObject({ threads: [{ id: "thr_fork" }], total: 1 })
      })
    })

    test("fences child admission by the active parent execution", async () => {
      await withStorage(async (storage, fixture) => {
        await createRunningParent(storage, fixture)
        const wrongLineage = subagentInput("parent_token", {
          id: "child_wrong_parent",
          executionId: "test_agent_execution:child_wrong_parent",
          spawnKey: "wrong-parent",
        })
        await createTestAgentExecution(fixture, {
          projectId,
          runId: wrongLineage.id,
          executionId: wrongLineage.executionId,
          sourceExecutionId: "unrelated_request_execution",
          authority: "inherited",
        })
        await expectAgentError(storage.runs.createSubagent(wrongLineage), "invalid_input")

        const input = subagentInput("stale_parent_token")
        await createTestAgentExecution(fixture, {
          projectId,
          runId: input.id,
          executionId: input.executionId,
          sourceExecutionId: "test_agent_execution:parent_1",
          authority: "inherited",
        })
        await expectAgentError(storage.runs.createSubagent(input), "execution_lost")

        await storage.runs.finish({
          projectId,
          id: "parent_1",
          executionToken: "parent_token",
          status: "succeeded",
        })
        await expectAgentError(
          storage.runs.createSubagent({ ...input, parentExecutionToken: "parent_token" }),
          "invalid_state"
        )
      })
    })

    test("enforces the active-child limit atomically", async () => {
      await withStorage(async (storage, fixture) => {
        await createRunningParent(storage, fixture)
        const inputs = ["child_a", "child_b"].map((id) =>
          subagentInput("parent_token", {
            id,
            executionId: `test_agent_execution:${id}`,
            spawnKey: id,
            maxActiveChildren: 1,
          })
        )
        for (const input of inputs) {
          await createTestAgentExecution(fixture, {
            projectId,
            runId: input.id,
            executionId: input.executionId,
            sourceExecutionId: "test_agent_execution:parent_1",
            authority: "inherited",
          })
        }

        const settled = await Promise.allSettled(
          inputs.map((input) => storage.runs.createSubagent(input))
        )
        expect(settled.filter((result) => result.status === "fulfilled")).toHaveLength(1)
        const rejected = settled.filter(
          (result): result is PromiseRejectedResult => result.status === "rejected"
        )
        expect(rejected).toHaveLength(1)
        expect(rejected[0]?.reason).toMatchObject({ code: "active_child_limit" })
      })
    })

    test("requires and round-trips a successful child result", async () => {
      await withStorage(async (storage, fixture) => {
        await createRunningParent(storage, fixture)
        await createSubagent(storage, fixture)
        await storage.runs.start({
          projectId,
          id: "child_1",
          modelId: "small",
          execution: execution("child_token"),
        })
        await expectAgentError(
          storage.runs.finish({
            projectId,
            id: "child_1",
            executionToken: "child_token",
            status: "succeeded",
          }),
          "invalid_input"
        )
        await expectAgentError(
          storage.runs.finish({
            projectId,
            id: "child_1",
            executionToken: "child_token",
            status: "succeeded",
            result: { text: "  " },
          }),
          "invalid_input"
        )
        // Only a paused child keeps mail it never read, for the run that continues it.
        await expectAgentError(
          storage.runs.finish({
            projectId,
            id: "child_1",
            executionToken: "child_token",
            status: "succeeded",
            result: { text: "Three open orders.", unread: [{ id: "m1", text: "Skip Globex." }] },
          }),
          "invalid_input"
        )

        await expectAgentError(
          storage.runs.finish({
            projectId,
            id: "child_1",
            executionToken: "child_token",
            status: "succeeded",
            result: {
              text: "Three open orders.",
              files: [{ path: "../orders.png", fileRef: testFileRef("orders.png") }],
            },
          }),
          "invalid_input"
        )

        const result = {
          text: "Three open orders.",
          files: [{ path: "charts/orders.png", fileRef: testFileRef("orders.png") }],
        }
        const completed = await storage.runs.finish({
          projectId,
          id: "child_1",
          executionToken: "child_token",
          status: "succeeded",
          result,
        })
        expect(completed).toMatchObject({ status: "succeeded", result })
        await expect(storage.runs.getById({ projectId, id: "child_1" })).resolves.toEqual(completed)
      })
    })

    // ── single-flight execution ─────────────────────────────────────────────────────────────────

    test("allows a single active run per thread", async () => {
      await withStorage(async (storage, fixture) => {
        await storage.threads.create(threadInput())

        const run = await createAndStartRun(storage, fixture, runInput({ id: "run_1" }))
        expect(run).toMatchObject({ status: "running", attempt: 1, threadId: "thr_1" })
        expect(run.executionId).toBe("test_agent_execution:run_1")
        expect(run.execution?.token).toBe("exec_1")
        await expect(storage.threads.getById({ projectId, id: "thr_1" })).resolves.toMatchObject({
          activeRunId: "run_1",
        })

        await expectAgentError(
          createAndStartRun(
            storage,
            fixture,
            runInput({ id: "run_2", execution: execution("exec_2") })
          ),
          "active_run_exists"
        )

        // Reservation against an unknown thread / duplicate run id.
        await expectAgentError(
          createAndStartRun(storage, fixture, runInput({ id: "run_x", threadId: "ghost" })),
          "thread_not_found"
        )
      })
    })

    test("never lets two concurrent queued runs both claim one thread", async () => {
      await withStorage(async (storage, fixture) => {
        await storage.threads.create(threadInput())

        const results = await Promise.allSettled([
          createAndStartRun(
            storage,
            fixture,
            runInput({ id: "run_a", execution: execution("exec_a") })
          ),
          createAndStartRun(
            storage,
            fixture,
            runInput({ id: "run_b", execution: execution("exec_b") })
          ),
        ])
        const fulfilled = results.filter((result) => result.status === "fulfilled")
        const rejected = results.filter(
          (result): result is PromiseRejectedResult => result.status === "rejected"
        )
        expect(fulfilled).toHaveLength(1)
        expect(rejected).toHaveLength(1)
        expect(rejected[0].reason).toBeInstanceOf(AgentStorageError)
        expect(rejected[0].reason.code).toBe("active_run_exists")
      })
    })

    // ── execution reclaim ───────────────────────────────────────────────────────────────────────

    test("projects confirmed queue ownership monotonically and reclaim fences stale executions", async () => {
      await withStorage(async (storage, fixture) => {
        await storage.threads.create(threadInput())
        await createAndStartRun(
          storage,
          fixture,
          runInput({
            id: "run_1",
            execution: execution("exec_1", at("2026-06-23T10:02:00.000Z")),
          })
        )

        const confirmed = await storage.runs.confirmExecutionOwnership({
          projectId,
          id: "run_1",
          executionToken: "exec_1",
          queueLeaseExpiresAt: at("2026-06-23T10:03:00.000Z"),
        })
        expect(confirmed.execution?.queueLeaseExpiresAt.toISOString()).toBe(
          "2026-06-23T10:03:00.000Z"
        )

        const older = await storage.runs.confirmExecutionOwnership({
          projectId,
          id: "run_1",
          executionToken: "exec_1",
          queueLeaseExpiresAt: at("2026-06-23T10:02:30.000Z"),
        })
        expect(older.execution?.queueLeaseExpiresAt.toISOString()).toBe("2026-06-23T10:03:00.000Z")

        // A takeover conditioned on a lapse that a renewal moved past leaves the run to its runner.
        await expectAgentError(
          storage.runs.reclaim({
            projectId,
            id: "run_1",
            execution: execution("exec_2", at("2026-06-23T10:04:00.000Z")),
            ifLapsedBy: at("2026-06-23T10:02:59.000Z"),
          }),
          "invalid_state"
        )
        const reclaimed = await storage.runs.reclaim({
          projectId,
          id: "run_1",
          execution: execution("exec_2", at("2026-06-23T10:04:00.000Z")),
          ifLapsedBy: at("2026-06-23T10:03:00.000Z"),
        })
        expect(reclaimed).toMatchObject({ status: "running", attempt: 2 })
        expect(reclaimed.execution?.token).toBe("exec_2")
        await expectAgentError(
          storage.runs.finish({
            projectId,
            id: "run_1",
            executionToken: "exec_1",
            status: "succeeded",
          }),
          "execution_lost"
        )
        await expectAgentError(
          storage.runs.confirmExecutionOwnership({
            projectId,
            id: "run_1",
            executionToken: "exec_1",
            queueLeaseExpiresAt: at("2026-06-23T10:05:00.000Z"),
          }),
          "execution_lost"
        )
      })
    })

    test("records a running run's cancel once, survives a reclaim, and leaves other states", async () => {
      await withStorage(async (storage, fixture) => {
        await storage.threads.create(threadInput())
        const queued = await createRun(storage, fixture, runInput({ id: "run_queued" }))
        expect(
          (await storage.runs.requestCancel({ projectId, id: queued.id })).cancelRequestedAt
        ).toBeUndefined()

        await storage.threads.create(threadInput({ id: "thread_2" }))
        await createAndStartRun(
          storage,
          fixture,
          runInput({
            id: "run_1",
            threadId: "thread_2",
            execution: execution("exec_1", at("2026-06-23T10:02:00.000Z")),
          })
        )
        const first = await storage.runs.requestCancel({
          projectId,
          id: "run_1",
          at: at("2026-06-23T10:01:00.000Z"),
        })
        expect(first.cancelRequestedAt?.toISOString()).toBe("2026-06-23T10:01:00.000Z")
        const again = await storage.runs.requestCancel({
          projectId,
          id: "run_1",
          at: at("2026-06-23T10:01:30.000Z"),
        })
        expect(again.cancelRequestedAt?.toISOString()).toBe("2026-06-23T10:01:00.000Z")

        // The renewal a runner makes reads it back, and a reclaim keeps it.
        const renewed = await storage.runs.confirmExecutionOwnership({
          projectId,
          id: "run_1",
          executionToken: "exec_1",
          queueLeaseExpiresAt: at("2026-06-23T10:03:00.000Z"),
        })
        expect(renewed.cancelRequestedAt?.toISOString()).toBe("2026-06-23T10:01:00.000Z")
        const reclaimed = await storage.runs.reclaim({
          projectId,
          id: "run_1",
          execution: execution("exec_2", at("2026-06-23T10:04:00.000Z")),
        })
        expect(reclaimed.cancelRequestedAt?.toISOString()).toBe("2026-06-23T10:01:00.000Z")

        await expectAgentError(
          storage.runs.requestCancel({ projectId, id: "run_missing" }),
          "run_not_found"
        )
      })
    })

    test("does not alias stored run records to callers", async () => {
      await withStorage(async (storage, fixture) => {
        await storage.threads.create(threadInput())
        const run = await createAndStartRun(storage, fixture, runInput({ id: "run_1" }))

        const mutableExecution = run.execution as
          | { token: string; queueLeaseExpiresAt: Date }
          | undefined
        if (mutableExecution) {
          mutableExecution.token = "mutated"
          mutableExecution.queueLeaseExpiresAt.setTime(0)
        }
        const reread = await storage.runs.getById({ projectId, id: "run_1" })
        expect(reread?.execution?.token).toBe("exec_1")
      })
    })

    // ── finalization ────────────────────────────────────────────────────────────────────────────

    test("releasing a run only clears its own thread's active pointer", async () => {
      await withStorage(async (storage, fixture) => {
        await storage.threads.create(threadInput({ id: "thr_1" }))
        await storage.threads.create(threadInput({ id: "thr_2" }))
        await createAndStartRun(storage, fixture, runInput({ id: "run_1", threadId: "thr_1" }))
        await createAndStartRun(
          storage,
          fixture,
          runInput({
            id: "run_2",
            threadId: "thr_2",
            execution: execution("exec_2"),
          })
        )

        await storage.runs.finish({
          projectId,
          id: "run_1",
          executionToken: "exec_1",
          status: "succeeded",
        })

        await expect(storage.threads.getById({ projectId, id: "thr_1" })).resolves.toMatchObject({
          activeRunId: null,
        })
        // thr_2's pointer is untouched — the release is scoped to the run's own thread + matching id.
        await expect(storage.threads.getById({ projectId, id: "thr_2" })).resolves.toMatchObject({
          activeRunId: "run_2",
        })
      })
    })

    test("finishes a run, records execution metadata, and releases the thread", async () => {
      await withStorage(async (storage, fixture) => {
        await storage.threads.create(threadInput())
        await createAndStartRun(storage, fixture, runInput({ id: "run_1" }))

        const finished = await storage.runs.finish({
          projectId,
          id: "run_1",
          executionToken: "exec_1",
          status: "succeeded",
          modelId: "claude-haiku-4-5",
          finishReason: "stop",
          diagnostics: [
            {
              code: "step_limit_reached",
              severity: "warning",
              scope: "run",
              message: "The Agent reached its 100-step limit before producing a final answer.",
            },
          ],
          completedAt: at("2026-06-23T10:07:00.000Z"),
        })
        expect(finished).toMatchObject({
          status: "succeeded",
          modelId: "claude-haiku-4-5",
          finishReason: "stop",
        })
        expect(finished.diagnostics).toEqual([
          {
            code: "step_limit_reached",
            severity: "warning",
            scope: "run",
            message: "The Agent reached its 100-step limit before producing a final answer.",
          },
        ])
        await expect(
          storage.runs.getByIds({ projectId, ids: ["run_1", "missing", "run_1"] })
        ).resolves.toEqual([finished])
        expect(finished.execution).toBeUndefined()
        expect(finished.completedAt?.toISOString()).toBe("2026-06-23T10:07:00.000Z")

        // The thread is released → a new queued run can be created and started.
        await expect(storage.threads.getById({ projectId, id: "thr_1" })).resolves.toMatchObject({
          activeRunId: null,
        })
        await expect(
          createAndStartRun(
            storage,
            fixture,
            runInput({ id: "run_2", execution: execution("exec_2") })
          )
        ).resolves.toMatchObject({ status: "running" })
      })
    })

    test("records failure detail and rejects a non-running run or stale execution", async () => {
      await withStorage(async (storage, fixture) => {
        await storage.threads.create(threadInput())
        await createAndStartRun(storage, fixture, runInput({ id: "run_1" }))

        await expectAgentError(
          storage.runs.finish({
            projectId,
            id: "run_1",
            executionToken: "wrong",
            status: "failed",
            error: failure("boom", "2026-06-23T10:08:00.000Z"),
          }),
          "execution_lost"
        )

        const failed = await storage.runs.finish({
          projectId,
          id: "run_1",
          executionToken: "exec_1",
          status: "failed",
          error: failure("ProviderError: boom", "2026-06-23T10:08:00.000Z"),
          completedAt: at("2026-06-23T10:08:00.000Z"),
        })
        expect(failed.status).toBe("failed")
        expect(failed.error).toEqual(failure("ProviderError: boom", "2026-06-23T10:08:00.000Z"))

        // Already terminal → cannot finish again.
        await expectAgentError(
          storage.runs.finish({
            projectId,
            id: "run_1",
            executionToken: "exec_1",
            status: "succeeded",
          }),
          "invalid_state"
        )
      })
    })

    test("lists runs with thread, status, and ordering filters", async () => {
      await withStorage(async (storage, fixture) => {
        await storage.threads.create(threadInput({ id: "thr_1" }))
        await storage.threads.create(threadInput({ id: "thr_2" }))

        await createAndStartRun(
          storage,
          fixture,
          runInput({
            id: "run_1",
            threadId: "thr_1",
            createdAt: at("2026-06-23T10:00:00.000Z"),
          })
        )
        await storage.runs.finish({
          projectId,
          id: "run_1",
          executionToken: "exec_1",
          status: "succeeded",
        })
        await createAndStartRun(
          storage,
          fixture,
          runInput({
            id: "run_2",
            threadId: "thr_1",
            execution: execution("exec_2"),
            createdAt: at("2026-06-23T10:30:00.000Z"),
          })
        )
        await createAndStartRun(
          storage,
          fixture,
          runInput({
            id: "run_3",
            threadId: "thr_2",
            execution: execution("exec_3"),
            createdAt: at("2026-06-23T10:45:00.000Z"),
          })
        )

        const forThread1 = await storage.runs.list({ projectId, threadId: "thr_1", order: "asc" })
        expect(forThread1.runs.map((run) => run.id)).toEqual(["run_1", "run_2"])

        const running = await storage.runs.list({ projectId, statuses: ["running"], order: "asc" })
        expect(running.runs.map((run) => run.id)).toEqual(["run_2", "run_3"])

        const all = await storage.runs.list({ projectId, order: "desc" })
        expect(all.runs.map((run) => run.id)).toEqual(["run_3", "run_2", "run_1"])
      })
    })

    test("filters queued runs by their effective created timestamp", async () => {
      await withStorage(async (storage, fixture) => {
        await storage.threads.create(threadInput({ id: "thr_before" }))
        await storage.threads.create(threadInput({ id: "thr_inside" }))
        await storage.threads.create(threadInput({ id: "thr_after" }))

        await createRun(
          storage,
          fixture,
          runInput({
            id: "run_before",
            threadId: "thr_before",
            createdAt: at("2026-06-23T10:00:00.000Z"),
          })
        )
        await createRun(
          storage,
          fixture,
          runInput({
            id: "run_inside",
            threadId: "thr_inside",
            createdAt: at("2026-06-23T11:00:00.000Z"),
          })
        )
        await createRun(
          storage,
          fixture,
          runInput({
            id: "run_after",
            threadId: "thr_after",
            createdAt: at("2026-06-23T12:00:00.000Z"),
          })
        )

        const result = await storage.runs.list({
          projectId,
          statuses: ["queued"],
          startedAfter: at("2026-06-23T10:30:00.000Z"),
          startedBefore: at("2026-06-23T11:30:00.000Z"),
          order: "asc",
        })
        expect(result.runs.map((run) => run.id)).toEqual(["run_inside"])
        expect(result.total).toBe(1)
        expect(result.hasMore).toBe(false)
      })
    })

    // ── messages ──────────────────────────────────────────────────────────────────────────────

    test("appends messages, assigns seq, and bumps thread stats", async () => {
      await withStorage(async (storage, fixture) => {
        await storage.threads.create(threadInput())

        const userMessage = await storage.messages.append({
          id: "msg_user_1",
          projectId,
          threadId: "thr_1",
          runId: null,
          role: "user",
          parts: [{ type: "text", text: "Hello agent" }],
          authorPrincipal: owner,
          createdAt: at("2026-06-23T10:00:30.000Z"),
        })
        expect(userMessage).toMatchObject({
          seq: 1,
          role: "user",
          runId: null,
          contentVersion: AGENT_MESSAGE_CONTENT_VERSION,
        })
        expect(userMessage.authorPrincipal).toEqual(owner)

        const run = await createAndStartRun(storage, fixture, runInput({ id: "run_1" }))
        expect(run.executionId).toBe("test_agent_execution:run_1")
        const assistantMessage = await storage.messages.append({
          id: "msg_asst_1",
          projectId,
          threadId: "thr_1",
          runId: "run_1",
          role: "assistant",
          authorPrincipal: serviceAccount,
          parts: [
            { type: "reasoning", text: "thinking about it" },
            {
              type: "tool-call",
              toolCallId: "call_1",
              toolName: "bash",
              input: { cmd: "ls" },
              state: "output-available",
              output: "file.txt",
            },
            { type: "text", text: "Here is the result" },
          ],
          createdAt: at("2026-06-23T10:01:00.000Z"),
        })
        expect(assistantMessage).toMatchObject({ seq: 2, role: "assistant", runId: "run_1" })
        expect(assistantMessage.authorPrincipal).toEqual(serviceAccount)

        const thread = await storage.threads.getById({ projectId, id: "thr_1" })
        expect(thread).toMatchObject({ messageCount: 2 })
        expect(thread?.lastMessageAt?.toISOString()).toBe("2026-06-23T10:01:00.000Z")

        // The message's `parts` are the canonical content and round-trip verbatim through storage.
        const stored = await storage.messages.getById({ projectId, id: "msg_asst_1" })
        expect(stored?.seq).toBe(2)
        expect(stored?.parts).toEqual([
          { type: "reasoning", text: "thinking about it" },
          {
            type: "tool-call",
            toolCallId: "call_1",
            toolName: "bash",
            input: { cmd: "ls" },
            state: "output-available",
            output: "file.txt",
          },
          { type: "text", text: "Here is the result" },
        ])
      })
    })

    test("deletes messages produced by a run and repairs thread stats", async () => {
      await withStorage(async (storage, fixture) => {
        await storage.threads.create(threadInput())
        await storage.messages.append({
          id: "msg_user_1",
          projectId,
          threadId: "thr_1",
          runId: null,
          role: "user",
          parts: [{ type: "text", text: "Try this" }],
          createdAt: at("2026-06-23T10:00:30.000Z"),
        })
        await createAndStartRun(storage, fixture, runInput({ id: "run_1" }))
        await storage.messages.append({
          id: "msg_asst_1",
          projectId,
          threadId: "thr_1",
          runId: "run_1",
          role: "assistant",
          parts: [
            { type: "text", text: "Partial answer" },
            {
              type: "tool-call",
              toolCallId: "call_1",
              toolName: "search",
              input: { query: "sixb" },
              state: "output-available",
              output: { matches: 1 },
            },
          ],
          createdAt: at("2026-06-23T10:01:00.000Z"),
        })

        await expect(
          storage.messages.deleteByRunId({ projectId, threadId: "thr_1", runId: "run_1" })
        ).resolves.toBe(1)
        await expect(storage.messages.getById({ projectId, id: "msg_asst_1" })).resolves.toBeNull()

        const messages = await storage.messages.list({ projectId, threadId: "thr_1" })
        expect(messages.messages.map((message) => message.id)).toEqual(["msg_user_1"])
        expect(messages.total).toBe(1)
        await expect(storage.threads.getById({ projectId, id: "thr_1" })).resolves.toMatchObject({
          messageCount: 1,
          lastMessageAt: at("2026-06-23T10:00:30.000Z"),
        })

        await expect(
          storage.messages.deleteByRunId({ projectId, threadId: "thr_1", runId: "run_1" })
        ).resolves.toBe(0)
        await expect(storage.threads.getById({ projectId, id: "thr_1" })).resolves.toMatchObject({
          messageCount: 1,
          lastMessageAt: at("2026-06-23T10:00:30.000Z"),
        })
      })
    })

    // Guard proof: drop the fence check from deleteByRunId; the stale token deletes the message.
    test("deletes a run's messages for a fencing run only while it runs under its token", async () => {
      await withStorage(async (storage, fixture) => {
        await storage.threads.create(threadInput())
        await createAndStartRun(
          storage,
          fixture,
          runInput({ id: "run_1", execution: execution("exec_1") })
        )
        await storage.messages.append({
          id: "msg_asst_1",
          projectId,
          threadId: "thr_1",
          runId: "run_1",
          role: "assistant",
          parts: [{ type: "text", text: "Hi." }],
        })
        const remove = (executionToken: string) =>
          storage.messages.deleteByRunId({
            projectId,
            threadId: "thr_1",
            runId: "run_1",
            fence: { runId: "run_1", executionToken },
          })

        await expectAgentError(remove("exec_stale"), "execution_lost")
        expect(await storage.messages.getById({ projectId, id: "msg_asst_1" })).not.toBeNull()
        await expect(remove("exec_1")).resolves.toBe(1)
      })
    })

    // Guard proof: make `countsAsThreadMessage` return true; the thread, its fork and the count
    // after a run's messages go read 2, 2 and 2.
    test("counts only the messages the conversation shows", async () => {
      await withStorage(async (storage, fixture) => {
        await storage.threads.create(threadInput())
        await storage.messages.append({
          id: "msg_user_1",
          projectId,
          threadId: "thr_1",
          runId: null,
          role: "user",
          parts: [{ type: "text", text: "Mark INV-2041 paid" }],
          createdAt: at("2026-06-23T10:00:30.000Z"),
        })
        // What Sixb writes to resume a turn once its calls are decided: the chat shows none of it.
        await storage.messages.append({
          id: "msg_resume_1",
          projectId,
          threadId: "thr_1",
          runId: null,
          role: "user",
          authorPrincipal: owner,
          parts: [
            {
              type: "approval-outcome",
              approvalId: "apr_1",
              status: "approved",
              call: {
                kind: "action",
                actionId: "mark-paid",
                subject: { kind: "object", objectTypeId: "invoice", primaryId: "INV-2041" },
              },
            },
          ],
          createdAt: at("2026-06-23T10:02:00.000Z"),
        })

        const thread = await storage.threads.getById({ projectId, id: "thr_1" })
        expect(thread).toMatchObject({ messageCount: 1 })
        // It is still the thread's latest message.
        expect(thread?.lastMessageAt?.toISOString()).toBe("2026-06-23T10:02:00.000Z")
        expect((await storage.threads.fork(forkInput())).messageCount).toBe(1)

        await createAndStartRun(storage, fixture, runInput({ id: "run_1" }))
        await storage.messages.append({
          id: "msg_asst_1",
          projectId,
          threadId: "thr_1",
          runId: "run_1",
          role: "assistant",
          parts: [{ type: "text", text: "Marked paid." }],
          createdAt: at("2026-06-23T10:03:00.000Z"),
        })
        expect(await storage.threads.getById({ projectId, id: "thr_1" })).toMatchObject({
          messageCount: 2,
        })

        await storage.messages.deleteByRunId({ projectId, threadId: "thr_1", runId: "run_1" })
        expect(await storage.threads.getById({ projectId, id: "thr_1" })).toMatchObject({
          messageCount: 1,
        })
      })
    })

    test("lists messages with role filter, ordering, and pagination", async () => {
      await withStorage(async (storage, fixture) => {
        await storage.threads.create(threadInput())
        await storage.messages.append({
          id: "m1",
          projectId,
          threadId: "thr_1",
          runId: null,
          role: "user",
          parts: [{ type: "text", text: "one" }],
          createdAt: at("2026-06-23T10:00:00.000Z"),
        })
        await createAndStartRun(storage, fixture, runInput({ id: "run_1" }))
        await storage.messages.append({
          id: "m2",
          projectId,
          threadId: "thr_1",
          runId: "run_1",
          role: "assistant",
          parts: [{ type: "text", text: "two" }],
          createdAt: at("2026-06-23T10:01:00.000Z"),
        })
        await storage.messages.append({
          id: "m3",
          projectId,
          threadId: "thr_1",
          runId: null,
          role: "user",
          parts: [{ type: "text", text: "three" }],
          createdAt: at("2026-06-23T10:02:00.000Z"),
        })

        const asc = await storage.messages.list({ projectId, threadId: "thr_1", order: "asc" })
        expect(asc.messages.map((message) => message.id)).toEqual(["m1", "m2", "m3"])
        expect(asc.total).toBe(3)

        const desc = await storage.messages.list({ projectId, threadId: "thr_1", order: "desc" })
        expect(desc.messages.map((message) => message.id)).toEqual(["m3", "m2", "m1"])

        const users = await storage.messages.list({
          projectId,
          threadId: "thr_1",
          roles: ["user"],
          order: "asc",
        })
        expect(users.messages.map((message) => message.id)).toEqual(["m1", "m3"])

        const retainedTail = await storage.messages.list({
          projectId,
          threadId: "thr_1",
          afterSeq: 1,
          order: "asc",
        })
        expect(retainedTail.messages.map((message) => message.id)).toEqual(["m2", "m3"])
        expect(retainedTail.total).toBe(2)

        const firstPage = await storage.messages.list({
          projectId,
          threadId: "thr_1",
          order: "asc",
          limit: 2,
        })
        expect(firstPage.messages.map((message) => message.id)).toEqual(["m1", "m2"])
        expect(firstPage.hasMore).toBe(true)
      })
    })

    test("rejects appends to missing threads, duplicate messages, and unknown runs", async () => {
      await withStorage(async (storage) => {
        await expectAgentError(
          storage.messages.append({
            id: "m1",
            projectId,
            threadId: "ghost",
            runId: null,
            role: "user",
            parts: [{ type: "text", text: "hi" }],
          }),
          "thread_not_found"
        )

        await storage.threads.create(threadInput())
        await storage.messages.append({
          id: "m1",
          projectId,
          threadId: "thr_1",
          runId: null,
          role: "user",
          parts: [{ type: "text", text: "hi" }],
        })
        await expectAgentError(
          storage.messages.append({
            id: "m1",
            projectId,
            threadId: "thr_1",
            runId: null,
            role: "user",
            parts: [{ type: "text", text: "dup" }],
          }),
          "duplicate_id"
        )
        await expectAgentError(
          storage.messages.append({
            id: "m2",
            projectId,
            threadId: "thr_1",
            runId: "ghost-run",
            role: "assistant",
            parts: [{ type: "text", text: "hi" }],
          }),
          "run_not_found"
        )
      })
    })

    // ── context checkpoints ─────────────────────────────────────────────────────────────────

    test("creates an idempotent checkpoint without mutating the transcript", async () => {
      await withStorage(async (storage, fixture) => {
        await prepareCheckpointCandidate(storage, fixture)
        await storage.threads.create(threadInput({ id: "thr_2" }))

        const threadBefore = await storage.threads.getById({ projectId, id: "thr_1" })
        const [created, replayed] = await Promise.all([
          storage.checkpoints.create(checkpointInput()),
          storage.checkpoints.create(checkpointInput()),
        ])

        expect(replayed).toEqual(created)
        expect(created).toMatchObject({
          id: "checkpoint_1",
          createdByRunId: "run_2",
          summarizedThroughSeq: 2,
          observedHeadSeq: 3,
        })
        expect(await storage.checkpoints.getLatest({ projectId, threadId: "thr_1" })).toEqual(
          created
        )
        expect(
          await storage.checkpoints.getLatest({ projectId: otherProjectId, threadId: "thr_1" })
        ).toBeNull()
        expect(await storage.checkpoints.getLatest({ projectId, threadId: "thr_2" })).toBeNull()
        await expect(
          storage.checkpoints.getByRunIds({
            projectId,
            threadId: "thr_1",
            runIds: ["run_2", "missing", "run_2"],
          })
        ).resolves.toEqual([created])
        await expect(
          storage.checkpoints.getByRunIds({
            projectId: otherProjectId,
            threadId: "thr_1",
            runIds: ["run_2"],
          })
        ).resolves.toEqual([])
        await expect(
          storage.checkpoints.getByRunIds({ projectId, threadId: "thr_2", runIds: ["run_2"] })
        ).resolves.toEqual([])

        const retained = await storage.messages.list({
          projectId,
          threadId: "thr_1",
          afterSeq: created.summarizedThroughSeq,
          order: "asc",
        })
        expect(retained.messages.map((message) => message.id)).toEqual(["m3"])

        const complete = await storage.messages.list({
          projectId,
          threadId: "thr_1",
          order: "asc",
        })
        expect(complete.messages.map((message) => message.id)).toEqual(["m1", "m2", "m3"])
        expect(await storage.threads.getById({ projectId, id: "thr_1" })).toEqual(threadBefore)
      })
    })

    test("rejects checkpoints from an inactive run or a different thread", async () => {
      await withStorage(async (storage, fixture) => {
        await prepareCheckpointCandidate(storage, fixture)
        await storage.threads.create(threadInput({ id: "thr_2" }))

        await expectAgentError(
          storage.checkpoints.create(checkpointInput({ threadId: "thr_2" })),
          "invalid_input"
        )

        await storage.runs.finish({
          id: "run_2",
          projectId,
          executionToken: "exec_2",
          status: "failed",
        })
        await expectAgentError(storage.checkpoints.create(checkpointInput()), "execution_lost")
        expect(await storage.checkpoints.getLatest({ projectId, threadId: "thr_1" })).toBeNull()
      })
    })

    test("rolls back a checkpoint with its containing storage transaction", async () => {
      await withStorage(async (storage, fixture) => {
        await prepareCheckpointCandidate(storage, fixture)
        const rollback = new Error("rollback checkpoint")

        await expect(
          fixture.transaction(async (tx) => {
            if (!tx.agents) throw new Error("Expected agent storage in transaction.")
            const created = await tx.agents.checkpoints.create(checkpointInput())
            expect(await tx.agents.checkpoints.getLatest({ projectId, threadId: "thr_1" })).toEqual(
              created
            )
            throw rollback
          })
        ).rejects.toBe(rollback)

        expect(await storage.checkpoints.getLatest({ projectId, threadId: "thr_1" })).toBeNull()
      })
    })

    test("fences checkpoint creation by execution, message head, and prior checkpoint", async () => {
      await withStorage(async (storage, fixture) => {
        await prepareCheckpointCandidate(storage, fixture)

        await expectAgentError(
          storage.checkpoints.create(checkpointInput({ executionToken: "stale" })),
          "execution_lost"
        )
        await expectAgentError(
          storage.checkpoints.create(
            checkpointInput({ expectedHeadSeq: 2, observedHeadSeq: 2, summarizedThroughSeq: 1 })
          ),
          "invalid_state"
        )
        await expectAgentError(
          storage.checkpoints.create(
            checkpointInput({ expectedPreviousCheckpointId: "checkpoint_missing" })
          ),
          "invalid_state"
        )
        await expectAgentError(
          storage.checkpoints.create(checkpointInput({ summarizedThroughSeq: 1 })),
          "invalid_input"
        )

        await storage.runs.reclaim({
          id: "run_2",
          projectId,
          execution: execution("exec_2_reclaimed"),
        })
        await expectAgentError(storage.checkpoints.create(checkpointInput()), "execution_lost")

        const reclaimedInput = checkpointInput({ executionToken: "exec_2_reclaimed" })
        await storage.checkpoints.create(reclaimedInput)
        await expectAgentError(
          storage.checkpoints.create({ ...reclaimedInput, summary: "different" }),
          "invalid_state"
        )
        await expectAgentError(storage.checkpoints.create(checkpointInput()), "execution_lost")
        await storage.messages.append({
          id: "m4",
          projectId,
          threadId: "thr_1",
          runId: "run_2",
          role: "assistant",
          parts: [{ type: "text", text: "four" }],
        })
        await expectAgentError(storage.checkpoints.create(reclaimedInput), "invalid_state")
      })
    })

    test("chains checkpoints only when the retained boundary advances", async () => {
      await withStorage(async (storage, fixture) => {
        await prepareCheckpointCandidate(storage, fixture)
        await storage.checkpoints.create(checkpointInput())
        await storage.messages.append({
          id: "m4",
          projectId,
          threadId: "thr_1",
          runId: "run_2",
          role: "assistant",
          parts: [{ type: "text", text: "four" }],
        })
        await storage.runs.finish({
          id: "run_2",
          projectId,
          executionToken: "exec_2",
          status: "succeeded",
        })
        await storage.messages.append({
          id: "m5",
          projectId,
          threadId: "thr_1",
          runId: null,
          role: "user",
          parts: [{ type: "text", text: "five" }],
        })
        await createAndStartRun(
          storage,
          fixture,
          runInput({ id: "run_3", triggerMessageId: "m5", execution: execution("exec_3") })
        )

        await expectAgentError(
          storage.checkpoints.create(
            checkpointInput({
              id: "checkpoint_2",
              createdByRunId: "run_3",
              expectedPreviousCheckpointId: "checkpoint_1",
              expectedHeadSeq: 5,
              executionToken: "exec_3",
              summarizedThroughSeq: 2,
              observedHeadSeq: 5,
            })
          ),
          "invalid_input"
        )

        const second = await storage.checkpoints.create(
          checkpointInput({
            id: "checkpoint_2",
            createdByRunId: "run_3",
            expectedPreviousCheckpointId: "checkpoint_1",
            expectedHeadSeq: 5,
            executionToken: "exec_3",
            summary: "The prior summary was extended through the fourth message.",
            summarizedThroughSeq: 4,
            observedHeadSeq: 5,
            createdAt: at("2026-06-23T10:05:00.000Z"),
          })
        )
        expect(second.previousCheckpointId).toBe("checkpoint_1")
        expect(await storage.checkpoints.getLatest({ projectId, threadId: "thr_1" })).toEqual(
          second
        )
      })
    })

    test("forks the finished history into a thread its caller owns alone", async () => {
      // Removal proof: copy every message while a turn is running; `m5` lands in the fork.
      await withStorage(async (storage, fixture) => {
        await prepareForkSource(storage, fixture)
        const sourceBefore = await storage.threads.getById({ projectId, id: "thr_1" })
        const source = await storage.messages.list({ projectId, threadId: "thr_1" })

        const fork = await storage.threads.fork(forkInput())

        expect(fork).toEqual({
          id: "thr_fork",
          projectId,
          kind: "conversation",
          ownerPrincipal: otherUser,
          title: "Slipped deals",
          status: "active",
          activeRunId: null,
          messageCount: 4,
          createdAt: at("2026-06-23T11:00:00.000Z"),
          updatedAt: at("2026-06-23T11:00:00.000Z"),
        })
        expect(await storage.threads.getById({ projectId, id: "thr_fork" })).toEqual(fork)

        const copied = await storage.messages.list({ projectId, threadId: "thr_fork" })
        const finished = source.messages.slice(0, 4)
        expect(copied.messages.map(({ id: _id, threadId: _threadId, ...rest }) => rest)).toEqual(
          finished.map(({ id: _id, threadId: _threadId, ...rest }) => rest)
        )
        expect(copied.messages.every((message) => message.threadId === "thr_fork")).toBe(true)

        const copiedIds = copied.messages.map((message) => message.id)
        expect(new Set(copiedIds).size).toBe(4)
        expect(copiedIds.some((id) => source.messages.some((message) => message.id === id))).toBe(
          false
        )

        // A fork of an old conversation sorts with what its owner just did.
        // Removal proof: give the fork the last copied message's time; it sorts after the source.
        const listed = await storage.threads.list({ projectId })
        expect(listed.threads.map((thread) => thread.id)).toEqual(["thr_fork", "thr_1"])

        // The source keeps everything, its running turn included.
        expect(await storage.threads.getById({ projectId, id: "thr_1" })).toEqual(sourceBefore)
        expect((await storage.messages.list({ projectId, threadId: "thr_1" })).messages).toEqual(
          source.messages
        )

        const next = await storage.messages.append({
          id: "m_fork_next",
          projectId,
          threadId: "thr_fork",
          runId: null,
          role: "user",
          parts: [{ type: "text", text: "Draft them for me." }],
        })
        expect(next.seq).toBe(5)
        expect(await storage.threads.getById({ projectId, id: "thr_fork" })).toMatchObject({
          messageCount: 5,
          lastMessageAt: next.createdAt,
        })
      })
    })

    test("copies a failed last turn with the checkpoint it wrote", async () => {
      await withStorage(async (storage, fixture) => {
        await prepareForkSource(storage, fixture)
        await storage.runs.finish({
          id: "run_3",
          projectId,
          executionToken: "exec_3",
          status: "failed",
        })

        const fork = await storage.threads.fork(forkInput())

        expect(fork.messageCount).toBe(5)
        expect(
          await storage.checkpoints.getLatest({ projectId, threadId: "thr_fork" })
        ).toMatchObject({ createdByRunId: "run_3", summarizedThroughSeq: 4, observedHeadSeq: 5 })
      })
    })

    test("forks a fork, which copies the same run's checkpoint again", async () => {
      await withStorage(async (storage, fixture) => {
        await prepareForkSource(storage, fixture)
        await storage.threads.fork(forkInput())

        const second = await storage.threads.fork(
          forkInput({ id: "thr_fork_of_fork", sourceThreadId: "thr_fork" })
        )

        expect(second.messageCount).toBe(4)
        const copies = await Promise.all(
          ["thr_1", "thr_fork", "thr_fork_of_fork"].map((threadId) =>
            storage.checkpoints.getByRunIds({ projectId, threadId, runIds: ["run_2"] })
          )
        )
        expect(copies.map(([checkpoint]) => checkpoint?.threadId)).toEqual([
          "thr_1",
          "thr_fork",
          "thr_fork_of_fork",
        ])
        expect(new Set(copies.map(([checkpoint]) => checkpoint?.id)).size).toBe(3)
        expect(
          await storage.checkpoints.getLatest({ projectId, threadId: "thr_fork_of_fork" })
        ).toEqual(copies[2]?.[0])
      })
    })

    test("keeps the latest checkpoint that does not anchor on the running turn", async () => {
      // Removal proof: drop the observed-head condition when choosing the checkpoint; the fork
      // keeps `checkpoint_2`, which anchors on the running turn's message the fork does not have.
      await withStorage(async (storage, fixture) => {
        await prepareForkSource(storage, fixture)
        const [first, second] = await storage.checkpoints.getByRunIds({
          projectId,
          threadId: "thr_1",
          runIds: ["run_2", "run_3"],
        })

        await storage.threads.fork(forkInput())

        const kept = await storage.checkpoints.getLatest({ projectId, threadId: "thr_fork" })
        if (!kept || !first) throw new Error("Expected the fork to keep checkpoint_1.")

        const { id: keptId, threadId: keptThreadId, previousCheckpointId, ...copied } = kept
        const { id: _firstId, threadId: _firstThreadId, ...original } = first
        expect(copied).toEqual(original)
        expect(keptId).not.toBe(first.id)
        expect(keptThreadId).toBe("thr_fork")
        expect(previousCheckpointId).toBeUndefined()

        // The fork's projection reads the kept checkpoint and the copied tail after it.
        const tail = await storage.messages.list({
          projectId,
          threadId: "thr_fork",
          afterSeq: kept.summarizedThroughSeq,
          order: "asc",
        })
        expect(
          projectAgentThreadModelContext({ checkpoint: kept, messages: tail.messages })
        ).toHaveLength(3)

        await expect(
          storage.checkpoints.getByRunIds({ projectId, threadId: "thr_fork", runIds: ["run_2"] })
        ).resolves.toEqual([kept])
        await expect(
          storage.checkpoints.getByRunIds({
            projectId,
            threadId: "thr_1",
            runIds: ["run_2", "run_3"],
          })
        ).resolves.toEqual([first, second])

        // Once the turn has finished, the checkpoint it wrote anchors on copied history.
        await storage.messages.append({
          id: "m6",
          projectId,
          threadId: "thr_1",
          runId: "run_3",
          role: "assistant",
          parts: [{ type: "text", text: "Drafted." }],
        })
        await storage.runs.finish({
          id: "run_3",
          projectId,
          executionToken: "exec_3",
          status: "succeeded",
        })
        await storage.threads.fork(forkInput({ id: "thr_fork_2" }))

        expect(
          await storage.checkpoints.getLatest({ projectId, threadId: "thr_fork_2" })
        ).toMatchObject({
          createdByRunId: "run_3",
          threadId: "thr_fork_2",
          summarizedThroughSeq: 4,
          observedHeadSeq: 5,
        })
        expect((await storage.threads.getById({ projectId, id: "thr_fork_2" }))?.messageCount).toBe(
          6
        )
      })
    })

    test("forks an empty thread and rejects a missing source or a taken id", async () => {
      await withStorage(async (storage) => {
        await storage.threads.create(threadInput())

        const fork = await storage.threads.fork(forkInput({ title: undefined }))
        expect(fork).toMatchObject({ messageCount: 0, activeRunId: null })
        expect(fork.createdAt).toEqual(at("2026-06-23T11:00:00.000Z"))
        expect(fork.lastMessageAt).toBeUndefined()
        expect(fork.title).toBeUndefined()

        await expectAgentError(storage.threads.fork(forkInput()), "duplicate_id")
        await expectAgentError(
          storage.threads.fork(forkInput({ id: "thr_other", sourceThreadId: "missing" })),
          "thread_not_found"
        )
        await expectAgentError(
          storage.threads.fork(forkInput({ id: "thr_other", projectId: otherProjectId })),
          "thread_not_found"
        )
      })
    })

    // Regression proof: drop the remap from a provider's fork; the copy then names the source's
    // artifact, which the fork's readers may not reach.
    test("names the fork's copies of the source's artifacts in the messages it copies", async () => {
      await withStorage(async (storage) => {
        await storage.threads.create(threadInput())
        const text = "See ![Revenue](artifact:art_0000000001#chart=revenue) and art_0000000009."
        await storage.messages.append({
          id: "msg_shown",
          projectId,
          threadId: "thr_1",
          runId: null,
          role: "user",
          parts: [{ type: "text", text }],
        })

        await storage.threads.fork(
          forkInput({ artifactCopies: { art_0000000001: "art_000000copy1" } })
        )

        const [copy] = (await storage.messages.list({ projectId, threadId: "thr_fork" })).messages
        expect(copy?.parts).toEqual([
          {
            type: "text",
            text: "See ![Revenue](artifact:art_000000copy1#chart=revenue) and art_0000000009.",
          },
        ])
        const [source] = (await storage.messages.list({ projectId, threadId: "thr_1" })).messages
        expect(source?.parts).toEqual([{ type: "text", text }])
      })
    })

    // Regression proof: drop the summary's remap in planAgentThreadFork; the copied checkpoint
    // then names the source's artifact.
    test("names the fork's copies in the checkpoint summary it copies", async () => {
      await withStorage(async (storage, fixture) => {
        const summary = "Drafted art_0000000001 for Acme; art_0000000009 is the source data."
        await prepareForkSource(storage, fixture, summary)
        await storage.runs.finish({
          id: "run_3",
          projectId,
          executionToken: "exec_3",
          status: "failed",
        })

        await storage.threads.fork(
          forkInput({ artifactCopies: { art_0000000001: "art_000000copy1" } })
        )

        expect(
          (await storage.checkpoints.getLatest({ projectId, threadId: "thr_fork" }))?.summary
        ).toBe("Drafted art_000000copy1 for Acme; art_0000000009 is the source data.")
        expect(
          (await storage.checkpoints.getLatest({ projectId, threadId: "thr_1" }))?.summary
        ).toBe(summary)
      })
    })

    test("starts a forked workspace with a new, reset sandbox", async () => {
      await withStorage(async (storage) => {
        await storage.threads.create(threadInput({ sandboxParams: { repo: "deals" } }))

        const fork = await storage.threads.fork(
          forkInput({ sandboxParams: { repo: "deals" }, sandboxName: "sixb-sb-fork" })
        )
        expect(fork.sandboxParams).toEqual({ repo: "deals" })
        expect(fork.sandboxState).toEqual({
          name: "sixb-sb-fork",
          status: "new",
          initialized: false,
          resetAt: "2026-06-23T11:00:00.000Z",
        })

        await expectAgentError(
          storage.threads.fork(forkInput({ id: "thr_2", sandboxParams: { repo: "deals" } })),
          "invalid_input"
        )
        await expectAgentError(
          storage.threads.fork(forkInput({ id: "thr_2", sandboxName: "sixb-sb-fork" })),
          "invalid_input"
        )
        await expectAgentError(
          storage.threads.fork(
            forkInput({ id: "thr_2", sandboxParams: {}, sandboxName: "../invalid" })
          ),
          "invalid_input"
        )
        expect(await storage.threads.getById({ projectId, id: "thr_2" })).toBeNull()
      })
    })

    test("rolls back a fork with its containing storage transaction", async () => {
      await withStorage(async (storage, fixture) => {
        await prepareForkSource(storage, fixture)
        const rollback = new Error("rollback fork")

        await expect(
          fixture.transaction(async (tx) => {
            if (!tx.agents) throw new Error("Expected agent storage in transaction.")
            await tx.agents.threads.fork(forkInput())
            throw rollback
          })
        ).rejects.toBe(rollback)

        expect(await storage.threads.getById({ projectId, id: "thr_fork" })).toBeNull()
        expect((await storage.messages.list({ projectId, threadId: "thr_fork" })).total).toBe(0)
        expect(await storage.checkpoints.getLatest({ projectId, threadId: "thr_fork" })).toBeNull()
      })
    })
  })
}
