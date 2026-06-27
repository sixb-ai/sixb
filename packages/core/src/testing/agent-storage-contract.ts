import { describe, expect, test } from "bun:test"
import type { Principal } from "../auth"
import {
  type AgentRunLease,
  type AgentStorage,
  AgentStorageError,
  type AgentStorageErrorCode,
  type CreateAgentThreadInput,
  type ReserveAgentRunInput,
} from "../storage/agents"

export interface AgentStorageContractSuiteOptions<TStorage extends AgentStorage = AgentStorage> {
  /** Factory that produces a fresh `AgentStorage` instance for each test case. */
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

function lease(id: string, expiresAt: string): AgentRunLease {
  return { id, expiresAt: at(expiresAt) }
}

function reserveInput(overrides: Partial<ReserveAgentRunInput> = {}): ReserveAgentRunInput {
  return {
    id: "run_1",
    projectId,
    threadId: "thr_1",
    agentId: "sales",
    triggerMessageId: "msg_user_1",
    requestedByPrincipal: owner,
    lease: lease("lease_1", "2026-06-23T10:05:00.000Z"),
    createdAt: at("2026-06-23T10:00:10.000Z"),
    ...overrides,
  }
}

/**
 * Runs the shared `AgentStorage` contract against any storage implementation.
 *
 * This is the storage-independent specification for Sixb agent persistence: thread lifecycle and
 * project isolation, single-flight run reservation, lease renewal / reclaim, run finalization with
 * execution metadata, and message append with thread-stats bookkeeping.
 */
export function runAgentStorageContractSuite<TStorage extends AgentStorage>(
  label: string,
  options: AgentStorageContractSuiteOptions<TStorage>
): void {
  const withStorage = async (body: (storage: TStorage) => Promise<void>): Promise<void> => {
    const storage = await options.createStorage()
    try {
      await body(storage)
    } finally {
      await options.teardown?.(storage)
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

    // ── single-flight reservation ───────────────────────────────────────────────────────────────

    test("reserves a single active run per thread (single-flight)", async () => {
      await withStorage(async (storage) => {
        await storage.threads.create(threadInput())

        const run = await storage.runs.reserve(reserveInput({ id: "run_1" }))
        expect(run).toMatchObject({ status: "running", attempt: 1, threadId: "thr_1" })
        expect(run.requestedByPrincipal).toEqual(owner)
        expect(run.lease?.id).toBe("lease_1")
        await expect(storage.threads.getById({ projectId, id: "thr_1" })).resolves.toMatchObject({
          activeRunId: "run_1",
        })

        await expectAgentError(
          storage.runs.reserve(
            reserveInput({ id: "run_2", lease: lease("lease_2", "2026-06-23T10:06:00.000Z") })
          ),
          "active_run_exists"
        )

        // Reservation against an unknown thread / duplicate run id.
        await expectAgentError(
          storage.runs.reserve(reserveInput({ id: "run_x", threadId: "ghost" })),
          "thread_not_found"
        )
      })
    })

    test("never lets two concurrent reservations both win", async () => {
      await withStorage(async (storage) => {
        await storage.threads.create(threadInput())

        const results = await Promise.allSettled([
          storage.runs.reserve(
            reserveInput({ id: "run_a", lease: lease("lease_a", "2026-06-23T10:05:00.000Z") })
          ),
          storage.runs.reserve(
            reserveInput({ id: "run_b", lease: lease("lease_b", "2026-06-23T10:05:00.000Z") })
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

    // ── lease renewal + reclaim ─────────────────────────────────────────────────────────────────

    test("renews a lease and rejects a stale lease id", async () => {
      await withStorage(async (storage) => {
        await storage.threads.create(threadInput())
        await storage.runs.reserve(reserveInput({ id: "run_1" }))

        const renewed = await storage.runs.renewLease({
          projectId,
          id: "run_1",
          leaseId: "lease_1",
          expiresAt: at("2026-06-23T10:10:00.000Z"),
        })
        expect(renewed.lease?.expiresAt.toISOString()).toBe("2026-06-23T10:10:00.000Z")

        await expectAgentError(
          storage.runs.renewLease({
            projectId,
            id: "run_1",
            leaseId: "wrong-lease",
            expiresAt: at("2026-06-23T10:11:00.000Z"),
          }),
          "lease_lost"
        )
        await expectAgentError(
          storage.runs.renewLease({
            projectId,
            id: "ghost",
            leaseId: "lease_1",
            expiresAt: at("2026-06-23T10:11:00.000Z"),
          }),
          "run_not_found"
        )
      })
    })

    test("reclaims only an expired lease and bumps the attempt", async () => {
      await withStorage(async (storage) => {
        await storage.threads.create(threadInput())
        await storage.runs.reserve(
          reserveInput({ id: "run_1", lease: lease("lease_1", "2026-06-23T10:05:00.000Z") })
        )

        // Lease still valid → cannot reclaim.
        await expectAgentError(
          storage.runs.reclaim({
            projectId,
            id: "run_1",
            lease: lease("lease_2", "2026-06-23T10:15:00.000Z"),
            now: at("2026-06-23T10:04:00.000Z"),
          }),
          "lease_not_expired"
        )

        // Lease expired → reclaim succeeds, new lease, attempt++.
        const reclaimed = await storage.runs.reclaim({
          projectId,
          id: "run_1",
          lease: lease("lease_2", "2026-06-23T10:15:00.000Z"),
          now: at("2026-06-23T10:06:00.000Z"),
        })
        expect(reclaimed).toMatchObject({ status: "running", attempt: 2 })
        expect(reclaimed.lease?.id).toBe("lease_2")

        // The old lease can no longer renew or finish the run.
        await expectAgentError(
          storage.runs.renewLease({
            projectId,
            id: "run_1",
            leaseId: "lease_1",
            expiresAt: at("2026-06-23T10:20:00.000Z"),
          }),
          "lease_lost"
        )
      })
    })

    test("reclaims a lease at the exact expiry boundary (expiresAt === now)", async () => {
      await withStorage(async (storage) => {
        await storage.threads.create(threadInput())
        await storage.runs.reserve(
          reserveInput({ id: "run_1", lease: lease("lease_1", "2026-06-23T10:05:00.000Z") })
        )

        // Boundary: a lease is reclaimable when expiresAt <= now (pins `<=`, not strict `<`).
        const reclaimed = await storage.runs.reclaim({
          projectId,
          id: "run_1",
          lease: lease("lease_2", "2026-06-23T10:15:00.000Z"),
          now: at("2026-06-23T10:05:00.000Z"),
        })
        expect(reclaimed).toMatchObject({ status: "running", attempt: 2 })
      })
    })

    test("does not alias stored run records to callers", async () => {
      await withStorage(async (storage) => {
        await storage.threads.create(threadInput())
        const run = await storage.runs.reserve(reserveInput({ id: "run_1" }))

        // Mutating the returned record must not bleed into the store.
        run.lease?.expiresAt.setTime(0)
        const reread = await storage.runs.getById({ projectId, id: "run_1" })
        expect(reread?.lease?.expiresAt.toISOString()).toBe("2026-06-23T10:05:00.000Z")
      })
    })

    // ── finalization ────────────────────────────────────────────────────────────────────────────

    test("releasing a run only clears its own thread's active pointer", async () => {
      await withStorage(async (storage) => {
        await storage.threads.create(threadInput({ id: "thr_1" }))
        await storage.threads.create(threadInput({ id: "thr_2" }))
        await storage.runs.reserve(reserveInput({ id: "run_1", threadId: "thr_1" }))
        await storage.runs.reserve(
          reserveInput({
            id: "run_2",
            threadId: "thr_2",
            lease: lease("lease_2", "2026-06-23T10:05:00.000Z"),
          })
        )

        await storage.runs.finish({
          projectId,
          id: "run_1",
          leaseId: "lease_1",
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
      await withStorage(async (storage) => {
        await storage.threads.create(threadInput())
        await storage.runs.reserve(reserveInput({ id: "run_1" }))

        const finished = await storage.runs.finish({
          projectId,
          id: "run_1",
          leaseId: "lease_1",
          status: "succeeded",
          modelId: "claude-haiku-4-5",
          finishReason: "stop",
          usage: { inputTokens: 120, outputTokens: 80, totalTokens: 200 },
          completedAt: at("2026-06-23T10:07:00.000Z"),
        })
        expect(finished).toMatchObject({
          status: "succeeded",
          modelId: "claude-haiku-4-5",
          finishReason: "stop",
        })
        expect(finished.usage).toEqual({ inputTokens: 120, outputTokens: 80, totalTokens: 200 })
        expect(finished.lease).toBeUndefined()
        expect(finished.completedAt?.toISOString()).toBe("2026-06-23T10:07:00.000Z")

        // The thread is released → a new run can be reserved.
        await expect(storage.threads.getById({ projectId, id: "thr_1" })).resolves.toMatchObject({
          activeRunId: null,
        })
        await expect(
          storage.runs.reserve(
            reserveInput({ id: "run_2", lease: lease("lease_2", "2026-06-23T11:05:00.000Z") })
          )
        ).resolves.toMatchObject({ status: "running" })
      })
    })

    test("records failure detail and rejects finishing a non-running or wrong-lease run", async () => {
      await withStorage(async (storage) => {
        await storage.threads.create(threadInput())
        await storage.runs.reserve(reserveInput({ id: "run_1" }))

        await expectAgentError(
          storage.runs.finish({
            projectId,
            id: "run_1",
            leaseId: "wrong",
            status: "failed",
            error: "boom",
          }),
          "lease_lost"
        )

        const failed = await storage.runs.finish({
          projectId,
          id: "run_1",
          leaseId: "lease_1",
          status: "failed",
          error: "ProviderError: boom",
          completedAt: at("2026-06-23T10:08:00.000Z"),
        })
        expect(failed.status).toBe("failed")
        expect(failed.error).toBe("ProviderError: boom")

        // Already terminal → cannot finish again.
        await expectAgentError(
          storage.runs.finish({ projectId, id: "run_1", leaseId: "lease_1", status: "succeeded" }),
          "invalid_state"
        )
      })
    })

    test("lists runs with thread, status, and ordering filters", async () => {
      await withStorage(async (storage) => {
        await storage.threads.create(threadInput({ id: "thr_1" }))
        await storage.threads.create(threadInput({ id: "thr_2" }))

        await storage.runs.reserve(
          reserveInput({
            id: "run_1",
            threadId: "thr_1",
            createdAt: at("2026-06-23T10:00:00.000Z"),
          })
        )
        await storage.runs.finish({
          projectId,
          id: "run_1",
          leaseId: "lease_1",
          status: "succeeded",
        })
        await storage.runs.reserve(
          reserveInput({
            id: "run_2",
            threadId: "thr_1",
            lease: lease("lease_2", "2026-06-23T11:00:00.000Z"),
            createdAt: at("2026-06-23T10:30:00.000Z"),
          })
        )
        await storage.runs.reserve(
          reserveInput({
            id: "run_3",
            threadId: "thr_2",
            lease: lease("lease_3", "2026-06-23T11:00:00.000Z"),
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

    // ── messages ──────────────────────────────────────────────────────────────────────────────

    test("appends messages, assigns seq, and bumps thread stats", async () => {
      await withStorage(async (storage) => {
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
        expect(userMessage).toMatchObject({ seq: 1, role: "user", runId: null, contentVersion: 1 })
        expect(userMessage.authorPrincipal).toEqual(owner)

        const run = await storage.runs.reserve(
          reserveInput({
            id: "run_1",
            executionPrincipal: serviceAccount,
          })
        )
        expect(run.executionPrincipal).toEqual(serviceAccount)
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

    test("lists messages with role filter, ordering, and pagination", async () => {
      await withStorage(async (storage) => {
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
        await storage.runs.reserve(reserveInput({ id: "run_1" }))
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
  })
}
