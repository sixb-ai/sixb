import { describe, expect, test } from "bun:test"
import type { AgentFilePart } from "../agents/message"
import type { Principal } from "../auth"
import {
  AGENT_THREAD_INBOX_MAX_ITEMS,
  type AgentStorage,
  AgentStorageError,
  type AgentStorageErrorCode,
} from "../storage/agents"
import type { ExecutionStorage } from "../storage/executions"
import { createTestAgentExecution } from "./agent-execution"

export interface AgentInboxStorageContractStorage {
  readonly agents: AgentStorage
  readonly executions: ExecutionStorage
}

export interface AgentInboxStorageContractSuiteOptions<
  TStorage extends AgentInboxStorageContractStorage = AgentInboxStorageContractStorage,
> {
  readonly createStorage: () => TStorage | Promise<TStorage>
  readonly teardown?: (storage: TStorage) => void | Promise<void>
}

const projectId = "inbox-contract"
const alice: Principal = { type: "user", id: "usr_alice" }
const bob: Principal = { type: "user", id: "usr_bob" }
const t0 = new Date("2026-11-14T16:00:00.000Z")

async function expectErrorCode(
  promise: Promise<unknown>,
  code: AgentStorageErrorCode
): Promise<void> {
  const error = await promise.catch((caught: unknown) => caught)
  expect(error).toBeInstanceOf(AgentStorageError)
  expect((error as AgentStorageError).code).toBe(code)
}

/** Provider-neutral persistence contract for `agent_thread_inbox`. */
export function runAgentInboxStorageContractSuite<
  TStorage extends AgentInboxStorageContractStorage,
>(label: string, options: AgentInboxStorageContractSuiteOptions<TStorage>): void {
  const withStorage = async (run: (storage: TStorage) => Promise<void>): Promise<void> => {
    const storage = await options.createStorage()
    try {
      await run(storage)
    } finally {
      await options.teardown?.(storage)
    }
  }

  const startConversationRun = async (
    storage: TStorage,
    threadId: string,
    runId: string,
    token: string
  ) => {
    const triggerId = `msg_trig_${runId}`
    await storage.agents.messages.append({
      id: triggerId,
      projectId,
      threadId,
      runId: null,
      role: "user",
      parts: [{ type: "text", text: "Start task" }],
      authorPrincipal: alice,
      createdAt: t0,
    })
    const executionId = await createTestAgentExecution(storage, { projectId, runId })
    await storage.agents.runs.create({
      id: runId,
      projectId,
      executionId,
      threadId,
      triggerMessageId: triggerId,
      spec: { model: { provider: "anthropic", modelId: "claude-sonnet-4.5" } },
      createdAt: t0,
    })
    await storage.agents.runs.start({
      projectId,
      id: runId,
      execution: { token, queueLeaseExpiresAt: new Date(Date.now() + 60_000) },
    })
    return executionId
  }

  describe(label, () => {
    test("enqueues items in FIFO seq order and reconciles idempotent retries", async () => {
      await withStorage(async (storage) => {
        await storage.agents.threads.create({
          id: "thr_1",
          projectId,
          ownerPrincipal: alice,
          createdAt: t0,
        })

        const first = await storage.agents.inbox.enqueue({
          id: "inb_1",
          projectId,
          threadId: "thr_1",
          messageId: "msg_1",
          authorPrincipal: alice,
          mode: "steer",
          parts: [{ type: "text", text: "Check src/v2 instead" }],
          timeZone: "America/New_York",
          locale: "en-US",
          createdAt: t0,
        })
        expect(first.created).toBe(true)
        expect(first.item.seq).toBe(1)

        // Retrying the same inbox id on the same thread returns the original item idempotently.
        const retried = await storage.agents.inbox.enqueue({
          id: "inb_1",
          projectId,
          threadId: "thr_1",
          messageId: "msg_other",
          authorPrincipal: bob,
          mode: "queue",
          parts: [{ type: "text", text: "Ignored retry payload" }],
        })
        expect(retried).toEqual({ item: first.item, created: false })

        const second = await storage.agents.inbox.enqueue({
          id: "inb_2",
          projectId,
          threadId: "thr_1",
          messageId: "msg_2",
          authorPrincipal: bob,
          mode: "queue",
          parts: [{ type: "text", text: "Run tests afterwards" }],
          spec: {
            model: { provider: "openai", modelId: "gpt-5" },
            reasoning: "high",
            approvalMode: "accept-edits",
          },
          createdAt: new Date(t0.getTime() + 1_000),
        })
        expect(second.created).toBe(true)
        expect(second.item.seq).toBe(2)

        const listed = await storage.agents.inbox.list({ projectId, threadId: "thr_1" })
        expect(listed.map((item) => item.id)).toEqual(["inb_1", "inb_2"])
        expect(listed[1]?.spec).toEqual({
          model: { provider: "openai", modelId: "gpt-5" },
          reasoning: "high",
          approvalMode: "accept-edits",
        })
      })
    })

    test("refuses duplicate ids, invalid threads, and inbox overflow", async () => {
      await withStorage(async (storage) => {
        await expectErrorCode(
          storage.agents.inbox.enqueue({
            id: "inb_missing",
            projectId,
            threadId: "thr_missing",
            messageId: "msg_missing",
            authorPrincipal: alice,
            mode: "steer",
            parts: [{ type: "text", text: "Hello" }],
          }),
          "thread_not_found"
        )

        await storage.agents.threads.create({
          id: "thr_a",
          projectId,
          ownerPrincipal: alice,
          createdAt: t0,
        })
        await storage.agents.threads.create({
          id: "thr_b",
          projectId,
          ownerPrincipal: alice,
          createdAt: t0,
        })
        await storage.agents.threads.create({
          id: "thr_archived",
          projectId,
          ownerPrincipal: alice,
          status: "archived",
          createdAt: t0,
        })

        await expectErrorCode(
          storage.agents.inbox.enqueue({
            id: "inb_arch",
            projectId,
            threadId: "thr_archived",
            messageId: "msg_arch",
            authorPrincipal: alice,
            mode: "queue",
            parts: [{ type: "text", text: "Archived" }],
          }),
          "invalid_state"
        )

        // Sub-agent threads use FamilyMailbox, never the conversation inbox.
        const parentExecId = await startConversationRun(
          storage,
          "thr_a",
          "run_parent",
          "tok_parent"
        )
        const childExecId = await createTestAgentExecution(storage, {
          projectId,
          runId: "run_child",
          sourceExecutionId: parentExecId,
        })
        await storage.agents.runs.createSubagent({
          id: "run_child",
          projectId,
          executionId: childExecId,
          parentRunId: "run_parent",
          parentExecutionToken: "tok_parent",
          spawnKey: "worker-1",
          thread: { id: "thr_sub", create: true },
          trigger: { id: "msg_sub_trig", parts: [{ type: "text", text: "Investigate" }] },
          maxActiveChildren: 4,
          spec: {
            model: { provider: "anthropic", modelId: "claude-sonnet-4.5" },
            task: "Investigate",
            toolNames: [],
          },
        })
        await expectErrorCode(
          storage.agents.inbox.enqueue({
            id: "inb_sub",
            projectId,
            threadId: "thr_sub",
            messageId: "msg_sub",
            authorPrincipal: alice,
            mode: "steer",
            parts: [{ type: "text", text: "Not a conversation" }],
          }),
          "thread_not_conversation"
        )

        await storage.agents.inbox.enqueue({
          id: "inb_shared_id",
          projectId,
          threadId: "thr_a",
          messageId: "msg_shared",
          authorPrincipal: alice,
          mode: "steer",
          parts: [{ type: "text", text: "First" }],
        })

        // Same inbox id on another thread fails with duplicate_id.
        await expectErrorCode(
          storage.agents.inbox.enqueue({
            id: "inb_shared_id",
            projectId,
            threadId: "thr_b",
            messageId: "msg_other",
            authorPrincipal: alice,
            mode: "steer",
            parts: [{ type: "text", text: "Cross thread" }],
          }),
          "duplicate_id"
        )

        // Same messageId on another inbox item or existing message fails with duplicate_id.
        await expectErrorCode(
          storage.agents.inbox.enqueue({
            id: "inb_dup_msg",
            projectId,
            threadId: "thr_a",
            messageId: "msg_shared",
            authorPrincipal: alice,
            mode: "queue",
            parts: [{ type: "text", text: "Dup message id" }],
          }),
          "duplicate_id"
        )
        await expectErrorCode(
          storage.agents.inbox.enqueue({
            id: "inb_dup_trig",
            projectId,
            threadId: "thr_a",
            messageId: "msg_trig_run_parent",
            authorPrincipal: alice,
            mode: "queue",
            parts: [{ type: "text", text: "Matches existing agent_messages row" }],
          }),
          "duplicate_id"
        )

        for (let i = 1; i <= AGENT_THREAD_INBOX_MAX_ITEMS; i += 1) {
          await storage.agents.inbox.enqueue({
            id: `inb_cap_${i}`,
            projectId,
            threadId: "thr_b",
            messageId: `msg_cap_${i}`,
            authorPrincipal: alice,
            mode: "queue",
            parts: [{ type: "text", text: `Item ${i}` }],
          })
        }
        await expectErrorCode(
          storage.agents.inbox.enqueue({
            id: "inb_cap_overflow",
            projectId,
            threadId: "thr_b",
            messageId: "msg_cap_overflow",
            authorPrincipal: alice,
            mode: "queue",
            parts: [{ type: "text", text: "Too many" }],
          }),
          "inbox_limit"
        )
      })
    })

    test("refuses a steer that carries a file, which a mid-turn read cannot prepare", async () => {
      await withStorage(async (storage) => {
        await storage.agents.threads.create({
          id: "thr_file",
          projectId,
          ownerPrincipal: alice,
          createdAt: t0,
        })
        const filePart: AgentFilePart = {
          type: "file",
          fileRef: {
            blobId: "blob_1",
            digest: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
            sizeBytes: 12,
            fileName: "chart.png",
            mediaType: "image/png",
          },
        }

        await expectErrorCode(
          storage.agents.inbox.enqueue({
            id: "inb_file_steer",
            projectId,
            threadId: "thr_file",
            messageId: "msg_file_steer",
            authorPrincipal: alice,
            mode: "steer",
            parts: [filePart],
          }),
          "invalid_input"
        )

        // The next turn prepares its attachments, so there it waits as a queued message.
        const queued = await storage.agents.inbox.enqueue({
          id: "inb_file_steer",
          projectId,
          threadId: "thr_file",
          messageId: "msg_file_steer",
          authorPrincipal: alice,
          mode: "queue",
          parts: [filePart],
        })
        expect(queued.created).toBe(true)

        // Promoting it to a steer is refused too, before a turn could read bytes it cannot replay.
        await expectErrorCode(
          storage.agents.inbox.update({
            projectId,
            threadId: "thr_file",
            id: "inb_file_steer",
            mode: "steer",
          }),
          "invalid_input"
        )
      })
    })

    test("fences takeSteers, blocks claimed edits, and consumes or releases claims", async () => {
      await withStorage(async (storage) => {
        await storage.agents.threads.create({
          id: "thr_steer",
          projectId,
          ownerPrincipal: alice,
          createdAt: t0,
        })
        await startConversationRun(storage, "thr_steer", "run_1", "tok_live")

        await storage.agents.inbox.enqueue({
          id: "inb_s1",
          projectId,
          threadId: "thr_steer",
          messageId: "msg_s1",
          authorPrincipal: alice,
          mode: "steer",
          parts: [{ type: "text", text: "Steer 1" }],
        })
        await storage.agents.inbox.enqueue({
          id: "inb_q1",
          projectId,
          threadId: "thr_steer",
          messageId: "msg_q1",
          authorPrincipal: alice,
          mode: "queue",
          parts: [{ type: "text", text: "Queue 1" }],
          spec: { reasoning: "high" },
        })
        await storage.agents.inbox.enqueue({
          id: "inb_imm",
          projectId,
          threadId: "thr_steer",
          messageId: "msg_imm",
          authorPrincipal: alice,
          mode: "steer",
          immediate: true,
          parts: [{ type: "text", text: "Immediate send-now item" }],
        })

        // Promote queue item to steer and clear spec before claiming.
        const promoted = await storage.agents.inbox.update({
          projectId,
          threadId: "thr_steer",
          id: "inb_q1",
          mode: "steer",
          spec: null,
        })
        expect(promoted?.mode).toBe("steer")
        expect(promoted?.spec).toBeUndefined()

        // Stale execution token is fenced.
        await expectErrorCode(
          storage.agents.inbox.takeSteers({
            projectId,
            threadId: "thr_steer",
            runId: "run_1",
            executionToken: "tok_stale",
            stepIndex: 1,
          }),
          "execution_lost"
        )

        // Valid token claims non-immediate steers in FIFO seq order.
        const taken = await storage.agents.inbox.takeSteers({
          projectId,
          threadId: "thr_steer",
          runId: "run_1",
          executionToken: "tok_live",
          stepIndex: 2,
          afterAnswer: true,
        })
        expect(taken.map((item) => item.id)).toEqual(["inb_s1", "inb_q1"])
        expect(taken[0]?.claimedBy).toEqual({
          runId: "run_1",
          executionToken: "tok_live",
          stepIndex: 2,
          afterAnswer: true,
        })

        // Unclaimed list excludes claimed steers while keeping the immediate item.
        const unclaimed = await storage.agents.inbox.list({
          projectId,
          threadId: "thr_steer",
          includeClaimed: false,
        })
        expect(unclaimed.map((item) => item.id)).toEqual(["inb_imm"])

        // Claimed items cannot be edited or removed by clients.
        await expectErrorCode(
          storage.agents.inbox.update({
            projectId,
            threadId: "thr_steer",
            id: "inb_s1",
            parts: [{ type: "text", text: "Too late" }],
          }),
          "invalid_state"
        )
        await expectErrorCode(
          storage.agents.inbox.remove({
            projectId,
            threadId: "thr_steer",
            id: "inb_s1",
          }),
          "invalid_state"
        )

        // consumeClaimed deletes persisted messageIds and releases unwritten ones.
        const consumed = await storage.agents.inbox.consumeClaimed({
          projectId,
          threadId: "thr_steer",
          runId: "run_1",
          executionToken: "tok_live",
          messageIds: ["msg_s1"],
        })
        expect(consumed.map((item) => item.id)).toEqual(["inb_s1"])

        const remaining = await storage.agents.inbox.list({ projectId, threadId: "thr_steer" })
        expect(
          remaining.map((item) => ({ id: item.id, claimed: item.claimedBy !== undefined }))
        ).toEqual([
          { id: "inb_q1", claimed: false },
          { id: "inb_imm", claimed: false },
        ])

        // Re-claim and test releaseClaimed on crash/cancel.
        await storage.agents.inbox.takeSteers({
          projectId,
          threadId: "thr_steer",
          runId: "run_1",
          executionToken: "tok_live",
          stepIndex: 3,
        })
        expect(await storage.agents.inbox.releaseClaimed({ projectId, runId: "run_1" })).toBe(1)
        const afterRelease = await storage.agents.inbox.getById({ projectId, id: "inb_q1" })
        expect(afterRelease?.claimedBy).toBeUndefined()
      })
    })

    test("takeNextQueued waits for idle and orders immediate, steer, then queue", async () => {
      await withStorage(async (storage) => {
        await storage.agents.threads.create({
          id: "thr_q",
          projectId,
          ownerPrincipal: alice,
          createdAt: t0,
        })
        await startConversationRun(storage, "thr_q", "run_busy", "tok_busy")

        await storage.agents.inbox.enqueue({
          id: "inb_queue_1",
          projectId,
          threadId: "thr_q",
          messageId: "msg_queue_1",
          authorPrincipal: alice,
          mode: "queue",
          parts: [{ type: "text", text: "Queue first" }],
        })
        await storage.agents.inbox.enqueue({
          id: "inb_late_steer",
          projectId,
          threadId: "thr_q",
          messageId: "msg_late_steer",
          authorPrincipal: alice,
          mode: "steer",
          parts: [{ type: "text", text: "Late steer" }],
        })
        await storage.agents.inbox.enqueue({
          id: "inb_send_now",
          projectId,
          threadId: "thr_q",
          messageId: "msg_send_now",
          authorPrincipal: alice,
          mode: "queue",
          immediate: true,
          parts: [{ type: "text", text: "Send right away" }],
        })

        // While activeRunId is set, takeNextQueued returns null without consuming anything.
        expect(
          await storage.agents.inbox.takeNextQueued({ projectId, threadId: "thr_q" })
        ).toBeNull()

        await storage.agents.runs.finish({
          projectId,
          id: "run_busy",
          executionToken: "tok_busy",
          status: "cancelled",
        })

        // After cancel (onlyImmediate: true), only the immediate item is popped.
        const firstPop = await storage.agents.inbox.takeNextQueued({
          projectId,
          threadId: "thr_q",
          onlyImmediate: true,
        })
        expect(firstPop?.id).toBe("inb_send_now")

        expect(
          await storage.agents.inbox.takeNextQueued({
            projectId,
            threadId: "thr_q",
            onlyImmediate: true,
          })
        ).toBeNull()

        // On clean idle (onlyImmediate: false), unclaimed steer drains before queue.
        const secondPop = await storage.agents.inbox.takeNextQueued({
          projectId,
          threadId: "thr_q",
        })
        expect(secondPop?.id).toBe("inb_late_steer")

        const thirdPop = await storage.agents.inbox.takeNextQueued({ projectId, threadId: "thr_q" })
        expect(thirdPop?.id).toBe("inb_queue_1")

        expect(
          await storage.agents.inbox.takeNextQueued({ projectId, threadId: "thr_q" })
        ).toBeNull()
      })
    })
  })
}
