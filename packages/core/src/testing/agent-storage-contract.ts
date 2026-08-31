import { describe, expect, test } from "bun:test"
import { AGENT_MESSAGE_CONTENT_VERSION } from "../agents/message"
import type { Principal } from "../auth"
import type { SixbFailure } from "../errors/types"
import {
  type AgentRunExecution,
  type AgentRunFailureCode,
  type AgentStorage,
  AgentStorageError,
  type AgentStorageErrorCode,
  type CreateAgentContextCheckpointInput,
  type CreateAgentRunInput,
  type CreateAgentThreadInput,
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
    agentId: "sales",
    ownerPrincipal: owner,
    createdAt: at("2026-06-23T10:00:00.000Z"),
    ...overrides,
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
    agentId: "sales",
    triggerMessageId: "msg_user_1",
    executionId: "test_agent_execution:run_1",
    requesterGroupIds: ["support", "engineering", "support"],
    execution: execution("exec_1"),
    createdAt: at("2026-06-23T10:00:10.000Z"),
    ...overrides,
  }
  return {
    ...input,
    executionId: overrides.executionId ?? `test_agent_execution:${input.id}`,
  }
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
    agentId: input.agentId,
    runId: input.id,
    executionId: input.executionId,
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
    // ── threads ───────────────────────────────────────────────────────────────────────────────

    test("creates threads, isolates projects, and rejects duplicate ids", async () => {
      await withStorage(async (storage) => {
        const thread = await storage.threads.create(threadInput({ title: "Q3 pipeline" }))
        expect(thread).toMatchObject({
          id: "thr_1",
          agentId: "sales",
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

    test("lists threads with filters, ordering, and pagination", async () => {
      await withStorage(async (storage) => {
        await storage.threads.create(
          threadInput({ id: "thr_a", agentId: "sales", createdAt: at("2026-06-23T10:00:00.000Z") })
        )
        await storage.threads.create(
          threadInput({
            id: "thr_b",
            agentId: "support",
            createdAt: at("2026-06-23T10:01:00.000Z"),
          })
        )
        await storage.threads.create(
          threadInput({
            id: "thr_c",
            agentId: "sales",
            status: "archived",
            createdAt: at("2026-06-23T10:02:00.000Z"),
          })
        )
        await storage.threads.create(threadInput({ id: "thr_other", projectId: otherProjectId }))

        const all = await storage.threads.list({ projectId, order: "asc" })
        expect(all.threads.map((thread) => thread.id)).toEqual(["thr_a", "thr_b", "thr_c"])
        expect(all.total).toBe(3)
        expect(all.hasMore).toBe(false)

        const sales = await storage.threads.list({ projectId, agentId: "sales", order: "asc" })
        expect(sales.threads.map((thread) => thread.id)).toEqual(["thr_a", "thr_c"])

        const visibleAgents = await storage.threads.list({
          projectId,
          agentIds: ["support"],
          order: "asc",
        })
        expect(visibleAgents.threads.map((thread) => thread.id)).toEqual(["thr_b"])

        const salesVisibleAgents = await storage.threads.list({
          projectId,
          agentId: "sales",
          agentIds: ["support"],
          order: "asc",
        })
        expect(salesVisibleAgents.threads).toEqual([])
        expect(salesVisibleAgents.total).toBe(0)

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

    // ── durable queued runs ────────────────────────────────────────────────────────────────────

    test("creates a queued run before execution and claims the thread", async () => {
      await withStorage(async (storage, fixture) => {
        await storage.threads.create(threadInput())

        const queued = await createRun(storage, fixture, runInput({ id: "run_1" }))
        expect(queued).toMatchObject({ status: "queued", attempt: 0, threadId: "thr_1" })
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

    test("rejects a run whose durable execution does not match its Agent authority", async () => {
      await withStorage(async (storage, fixture) => {
        await storage.threads.create(threadInput())
        const executionId = await createTestAgentExecution(fixture, {
          projectId,
          agentId: "support",
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

    // ── single-flight execution ─────────────────────────────────────────────────────────────────

    test("allows a single active run per thread", async () => {
      await withStorage(async (storage, fixture) => {
        await storage.threads.create(threadInput())

        const run = await createAndStartRun(storage, fixture, runInput({ id: "run_1" }))
        expect(run).toMatchObject({ status: "running", attempt: 1, threadId: "thr_1" })
        expect(run.executionId).toBe("test_agent_execution:run_1")
        expect(run.requesterGroupIds).toEqual(["engineering", "support"])
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

    test("reclaim rotates the execution token and bumps the attempt", async () => {
      await withStorage(async (storage, fixture) => {
        await storage.threads.create(threadInput())
        await createAndStartRun(storage, fixture, runInput({ id: "run_1" }))

        const reclaimed = await storage.runs.reclaim({
          projectId,
          id: "run_1",
          execution: execution("exec_2"),
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
      })
    })

    test("projects confirmed queue ownership monotonically and fences stale executions", async () => {
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

        await storage.runs.reclaim({
          projectId,
          id: "run_1",
          execution: execution("exec_2", at("2026-06-23T10:04:00.000Z")),
        })
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
        ;(run.requesterGroupIds as string[]).push("mutated")
        const reread = await storage.runs.getById({ projectId, id: "run_1" })
        expect(reread?.execution?.token).toBe("exec_1")
        expect(reread?.requesterGroupIds).toEqual(["engineering", "support"])
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
              code: "output_file_too_large",
              severity: "warning",
              scope: "output",
              path: "reports/full.csv",
              message: "This generated file was skipped.",
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
            code: "output_file_too_large",
            severity: "warning",
            scope: "output",
            path: "reports/full.csv",
            message: "This generated file was skipped.",
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
            runIds: ["run_2", "missing", "run_2"],
          })
        ).resolves.toEqual([created])
        await expect(
          storage.checkpoints.getByRunIds({
            projectId: otherProjectId,
            runIds: ["run_2"],
          })
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
        await expectAgentError(storage.checkpoints.create(checkpointInput()), "invalid_state")
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
  })
}
