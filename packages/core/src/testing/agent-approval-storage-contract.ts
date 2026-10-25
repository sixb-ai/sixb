import { describe, expect, test } from "bun:test"
import type { Principal } from "../auth"
import {
  type AgentApprovalCall,
  type AgentApprovalCursor,
  type AgentStorage,
  AgentStorageError,
  type AgentStorageErrorCode,
  type RequestAgentApprovalInput,
} from "../storage/agents"
import type { AuthStorage } from "../storage/auth"
import type { ExecutionStorage } from "../storage/executions"
import type { Storage } from "../storage/types"
import { createTestAgentExecution } from "./agent-execution"

export interface AgentApprovalStorageContractStorage extends Pick<Storage, "transaction"> {
  readonly agents: AgentStorage
  readonly auth: AuthStorage
  readonly executions: ExecutionStorage
}

export interface AgentApprovalStorageContractSuiteOptions<
  TStorage extends AgentApprovalStorageContractStorage = AgentApprovalStorageContractStorage,
> {
  /** Returns a fresh, empty storage bundle for every test. */
  readonly createStorage: () => TStorage | Promise<TStorage>
  readonly teardown?: (storage: TStorage) => void | Promise<void>
}

const projectId = "approval-contract"
const otherProjectId = "approval-contract-other"
const priya: Principal = { type: "user", id: "usr_priya" }
const marc: Principal = { type: "user", id: "usr_marc" }
const t0 = new Date("2026-10-24T10:00:00.000Z")
const week = 7 * 24 * 60 * 60 * 1000

const markPaid: AgentApprovalCall = {
  kind: "action",
  actionId: "mark-paid",
  subject: { kind: "object", objectTypeId: "invoice", primaryId: "INV-2041" },
  params: { paidOn: "2026-10-24", amount: 1240, note: null },
  actionRunId: "act_mark_paid",
  effect: "external",
}

const markPaidCall = markPaid as Extract<AgentApprovalCall, { readonly kind: "action" }>

const sendReminders: AgentApprovalCall = {
  kind: "workflow",
  workflowId: "send-reminders",
  input: { overdueDays: 30, channels: ["email"] },
  workflowRunId: "run_reminders",
}

/** Provider-neutral contract for held Agent calls and each user's approval mode. */
export function runAgentApprovalStorageContractSuite<
  TStorage extends AgentApprovalStorageContractStorage,
>(label: string, options: AgentApprovalStorageContractSuiteOptions<TStorage>): void {
  const withStorage = async (run: (storage: TStorage) => Promise<void>): Promise<void> => {
    const storage = await options.createStorage()
    try {
      await run(storage)
    } finally {
      await options.teardown?.(storage)
    }
  }

  describe(label, () => {
    test("holds a call once per call key, whatever id the next request brings", async () => {
      await withStorage(async (storage) => {
        await startTurn(storage)

        const first = await storage.agents.approvals.request(approvalInput())
        const again = await storage.agents.approvals.request(approvalInput({ id: "apr_2" }))

        expect(first).toEqual({
          created: true,
          approval: {
            id: "apr_1",
            projectId,
            threadId: "thr_1",
            runId: "run_1",
            callerRunId: "run_1",
            requestedBy: priya,
            mode: "manual",
            callKey: "act_mark_paid",
            call: markPaid,
            status: "pending",
            createdAt: t0,
            expiresAt: new Date(t0.getTime() + week),
          },
        })
        expect(again).toEqual({ created: false, approval: first.approval })
        expect(await storage.agents.approvals.getById({ projectId, id: "apr_2" })).toBeNull()
      })
    })

    test("keeps a workflow call's input as it was held", async () => {
      await withStorage(async (storage) => {
        await startTurn(storage)

        const { approval } = await storage.agents.approvals.request(
          approvalInput({ call: sendReminders, mode: "accept-edits" })
        )

        expect(await storage.agents.approvals.getById({ projectId, id: approval.id })).toEqual(
          approval
        )
        expect(approval).toMatchObject({
          callKey: "run_reminders",
          call: sendReminders,
          mode: "accept-edits",
        })
      })
    })

    test("holds a call only for the current delivery of a running run of the turn", async () => {
      await withStorage(async (storage) => {
        await startTurn(storage)
        await startTurn(storage, { threadId: "thr_2", runId: "run_2", token: "token_2" })

        await expectAgentError(
          storage.agents.approvals.request(approvalInput({ executionToken: "stale" })),
          "execution_lost"
        )
        await expectAgentError(
          storage.agents.approvals.request(approvalInput({ callerRunId: "run_2" })),
          "invalid_input"
        )
        await expectAgentError(
          storage.agents.approvals.request(approvalInput({ runId: "run_missing" })),
          "run_not_found"
        )

        await finishTurn(storage, "succeeded")
        await expectAgentError(storage.agents.approvals.request(approvalInput()), "invalid_state")
        expect((await storage.agents.approvals.list({ projectId })).total).toBe(0)
      })
    })

    test("holds a child's call for the turn that spawned it", async () => {
      await withStorage(async (storage) => {
        await startTurn(storage)
        await startChild(storage)

        const { approval } = await storage.agents.approvals.request(
          approvalInput({ callerRunId: "child_1", executionToken: "child_token" })
        )

        expect(approval).toMatchObject({
          runId: "run_1",
          callerRunId: "child_1",
          threadId: "thr_1",
        })
        await expectAgentError(
          storage.agents.approvals.request(
            approvalInput({ id: "apr_2", callerRunId: "child_1", executionToken: "token_1" })
          ),
          "execution_lost"
        )
      })
    })

    test("decides a pending approval once", async () => {
      await withStorage(async (storage) => {
        await startTurn(storage)
        await storage.agents.approvals.request(approvalInput())
        const decidedAt = new Date(t0.getTime() + 60_000)

        const approved = await storage.agents.approvals.decide(decision("approved", decidedAt))
        const repeated = await storage.agents.approvals.decide(decision("approved"))
        const denied = await storage.agents.approvals.decide(decision("denied"))

        const decided = expect.objectContaining({ status: "approved", decidedAt, decidedBy: priya })
        expect(approved).toEqual({ decided: true, approval: decided })
        expect(repeated).toEqual({ decided: false, approval: decided })
        expect(denied).toEqual({ decided: false, approval: decided })
        expect(
          await storage.agents.approvals.decide({ ...decision("denied"), id: "apr_missing" })
        ).toBeNull()
      })
    })

    test("expires an approval decided after its time ran out", async () => {
      await withStorage(async (storage) => {
        await startTurn(storage)
        await storage.agents.approvals.request(approvalInput())

        const late = await storage.agents.approvals.decide(
          decision("approved", new Date(t0.getTime() + week))
        )

        expect(late?.decided).toBe(false)
        expect(late?.approval.status).toBe("expired")
        expect(late?.approval.decidedAt).toBeUndefined()
        expect(await storage.agents.approvals.getById({ projectId, id: "apr_1" })).toEqual(
          late?.approval ?? null
        )
      })
    })

    test("records what an approved call gave, once", async () => {
      await withStorage(async (storage) => {
        await startTurn(storage)
        await storage.agents.approvals.request(approvalInput())

        await expectAgentError(
          storage.agents.approvals.recordOutcome({ projectId, id: "apr_1", outcome: ran("act_1") }),
          "invalid_state"
        )

        await storage.agents.approvals.decide(decision("approved"))
        const recorded = await storage.agents.approvals.recordOutcome({
          projectId,
          id: "apr_1",
          outcome: ran("act_mark_paid"),
        })
        const second = await storage.agents.approvals.recordOutcome({
          projectId,
          id: "apr_1",
          outcome: {
            kind: "error",
            error: { code: "internal.unexpected", message: "Late", retryable: false, at: "x" },
          },
        })

        expect(recorded.outcome).toEqual(ran("act_mark_paid"))
        expect(second).toEqual(recorded)
      })
    })

    test("settles a thread's pending approvals, and a settled one frees its call key", async () => {
      await withStorage(async (storage) => {
        await startTurn(storage)
        await storage.agents.approvals.request(approvalInput())
        await storage.agents.approvals.request(
          approvalInput({ id: "apr_2", call: sendReminders, createdAt: new Date(t0.getTime() + 1) })
        )
        await storage.agents.approvals.decide({ ...decision("denied"), id: "apr_2" })

        const settled = await storage.agents.approvals.settle({
          projectId,
          threadId: "thr_1",
          status: "superseded",
        })
        const asked = await storage.agents.approvals.request(approvalInput({ id: "apr_3" }))
        const deniedAgain = await storage.agents.approvals.request(
          approvalInput({ id: "apr_4", call: sendReminders })
        )

        expect(settled.map((approval) => [approval.id, approval.status])).toEqual([
          ["apr_1", "superseded"],
        ])
        expect(asked).toMatchObject({ created: true, approval: { id: "apr_3", status: "pending" } })
        expect(deniedAgain).toMatchObject({ created: false, approval: { id: "apr_2" } })
      })
    })

    test("marks approvals reported by one message only", async () => {
      await withStorage(async (storage) => {
        await startTurn(storage)
        await storage.agents.approvals.request(approvalInput())
        await storage.agents.approvals.request(approvalInput({ id: "apr_2", call: sendReminders }))
        await storage.agents.approvals.settle({
          projectId,
          threadId: "thr_1",
          status: "superseded",
        })

        const first = await storage.agents.approvals.markReported({
          projectId,
          threadId: "thr_1",
          ids: ["apr_1", "apr_missing"],
          messageId: "msg_2",
        })
        const racing = await storage.agents.approvals.markReported({
          projectId,
          threadId: "thr_1",
          ids: ["apr_1", "apr_2"],
          messageId: "msg_3",
        })
        const otherThread = await storage.agents.approvals.markReported({
          projectId,
          threadId: "thr_2",
          ids: ["apr_1"],
          messageId: "msg_4",
        })

        expect(first).toEqual(["apr_1"])
        expect(racing).toEqual(["apr_2"])
        expect(otherThread).toEqual([])
        expect(
          (await storage.agents.approvals.getById({ projectId, id: "apr_1" }))?.reportedInMessageId
        ).toBe("msg_2")
      })
    })

    test("lists approvals oldest first by thread, run, requester, status and report", async () => {
      await withStorage(async (storage) => {
        await startTurn(storage)
        await startTurn(storage, {
          threadId: "thr_2",
          runId: "run_2",
          token: "token_2",
          requestedBy: marc,
        })
        await storage.agents.approvals.request(
          approvalInput({ id: "apr_late", createdAt: new Date(t0.getTime() + 2) })
        )
        await storage.agents.approvals.request(
          approvalInput({ id: "apr_early", call: sendReminders })
        )
        await storage.agents.approvals.request(
          approvalInput({
            id: "apr_marc",
            runId: "run_2",
            callerRunId: "run_2",
            executionToken: "token_2",
            requestedBy: marc,
            createdAt: new Date(t0.getTime() + 1),
          })
        )
        await storage.agents.approvals.decide({ ...decision("denied"), id: "apr_early" })
        await storage.agents.approvals.markReported({
          projectId,
          threadId: "thr_1",
          ids: ["apr_early"],
          messageId: "msg_2",
        })

        const ids = async (input: Partial<Parameters<AgentStorage["approvals"]["list"]>[0]>) =>
          (await storage.agents.approvals.list({ projectId, ...input })).approvals.map(
            (approval) => approval.id
          )

        expect(await ids({})).toEqual(["apr_early", "apr_marc", "apr_late"])
        expect(await ids({ threadId: "thr_1" })).toEqual(["apr_early", "apr_late"])
        expect(await ids({ runId: "run_2" })).toEqual(["apr_marc"])
        expect(await ids({ requestedBy: priya, statuses: ["pending"] })).toEqual(["apr_late"])
        expect(await ids({ reported: false })).toEqual(["apr_marc", "apr_late"])
        expect(await ids({ reported: true })).toEqual(["apr_early"])
        expect(await storage.agents.approvals.list({ projectId, limit: 1, offset: 1 })).toEqual({
          approvals: [expect.objectContaining({ id: "apr_marc" })],
          hasMore: true,
          total: 3,
        })
        expect((await storage.agents.approvals.list({ projectId: otherProjectId })).total).toBe(0)
      })
    })

    for (const status of ["failed", "cancelled"] as const) {
      test(`a turn that ends ${status} cancels its pending approvals with it`, async () => {
        await withStorage(async (storage) => {
          await startTurn(storage)
          await storage.agents.approvals.request(approvalInput())
          await storage.agents.approvals.request(
            approvalInput({ id: "apr_2", call: sendReminders })
          )
          await storage.agents.approvals.decide({ ...decision("approved"), id: "apr_2" })

          await finishTurn(storage, status)

          expect(await statuses(storage)).toEqual([
            ["apr_1", "cancelled"],
            ["apr_2", "approved"],
          ])
        })
      })
    }

    test("a child that fails cancels its own pending approvals, not its turn's", async () => {
      await withStorage(async (storage) => {
        await startTurn(storage)
        await startChild(storage)
        await storage.agents.approvals.request(approvalInput())
        await storage.agents.approvals.request(
          approvalInput({
            id: "apr_child",
            callerRunId: "child_1",
            executionToken: "child_token",
            call: sendReminders,
          })
        )

        await storage.agents.runs.finish({
          projectId,
          id: "child_1",
          executionToken: "child_token",
          status: "failed",
        })

        expect(await statuses(storage)).toEqual([
          ["apr_1", "pending"],
          ["apr_child", "cancelled"],
        ])
      })
    })

    test("a turn that pauses keeps its approvals for their decision", async () => {
      await withStorage(async (storage) => {
        await startTurn(storage)
        await storage.agents.approvals.request(approvalInput())

        await finishTurn(storage, "succeeded", "awaiting_approval")

        expect(await storage.agents.approvals.getById({ projectId, id: "apr_1" })).toMatchObject({
          status: "pending",
        })
        expect(
          (await storage.agents.approvals.getById({ projectId, id: "apr_1" }))?.turnStoppedAt
        ).toBeUndefined()
      })
    })

    // A call can land after the turn's last check and before its finish.
    test("a turn that succeeds without pausing cancels a late call and never resumes", async () => {
      await withStorage(async (storage) => {
        await startTurn(storage)
        await storage.agents.approvals.request(approvalInput())
        await storage.agents.approvals.request(approvalInput({ id: "apr_2", call: sendReminders }))
        await storage.agents.approvals.decide({ ...decision("denied"), id: "apr_2" })

        await finishTurn(storage, "succeeded")

        const approvals = (await storage.agents.approvals.list({ projectId })).approvals
        expect(approvals.map(({ id, status }) => [id, status])).toEqual([
          ["apr_1", "cancelled"],
          ["apr_2", "denied"],
        ])
        expect(approvals.every((approval) => approval.turnStoppedAt !== undefined)).toBe(true)
      })
    })

    test("a child that succeeds leaves its turn's approvals waiting", async () => {
      await withStorage(async (storage) => {
        await startTurn(storage)
        await startChild(storage)
        await storage.agents.approvals.request(
          approvalInput({ callerRunId: "child_1", executionToken: "child_token" })
        )

        await storage.agents.runs.finish({
          projectId,
          id: "child_1",
          executionToken: "child_token",
          status: "succeeded",
          result: { text: "Waiting for approval." },
        })

        expect(await statuses(storage)).toEqual([["apr_1", "pending"]])
      })
    })

    test("a turn pauses for approval only while it holds a call", async () => {
      await withStorage(async (storage) => {
        await startTurn(storage)
        await startTurn(storage, { threadId: "thr_2", runId: "run_2", token: "token_2" })
        await storage.agents.approvals.request(approvalInput())
        await storage.agents.approvals.decide(decision("approved"))
        const pause = { projectId, finishReason: "awaiting_approval" } as const

        // Decided before the turn could pause, and not reported yet: the turn still holds it.
        expect(await storage.agents.approvals.holdsRun({ projectId, runId: "run_1" })).toBe(true)
        expect(await storage.agents.approvals.holdsRun({ projectId, runId: "run_2" })).toBe(false)
        const paused = await storage.agents.runs.finish({
          ...pause,
          id: "run_1",
          executionToken: "token_1",
          status: "succeeded",
        })
        await expectAgentError(
          storage.agents.runs.finish({
            ...pause,
            id: "run_2",
            executionToken: "token_2",
            status: "succeeded",
          }),
          "invalid_input"
        )
        await expectAgentError(
          storage.agents.runs.finish({
            projectId,
            id: "run_2",
            executionToken: "token_2",
            status: "failed",
            finishReason: "awaiting_approval" as "error",
          }),
          "invalid_input"
        )

        expect(paused).toMatchObject({ status: "succeeded", finishReason: "awaiting_approval" })
        expect(await storage.agents.runs.getById({ projectId, id: "run_2" })).toMatchObject({
          status: "running",
        })
      })
    })

    test("a reported call no longer holds its turn", async () => {
      await withStorage(async (storage) => {
        await startTurn(storage)
        await storage.agents.approvals.request(approvalInput())
        await storage.agents.approvals.settle({
          projectId,
          threadId: "thr_1",
          status: "superseded",
        })
        await storage.agents.approvals.markReported({
          projectId,
          threadId: "thr_1",
          ids: ["apr_1"],
          messageId: "msg_2",
        })

        expect(await storage.agents.approvals.holdsRun({ projectId, runId: "run_1" })).toBe(false)
        await expectAgentError(
          storage.agents.runs.finish({
            projectId,
            id: "run_1",
            executionToken: "token_1",
            status: "succeeded",
            finishReason: "awaiting_approval",
          }),
          "invalid_input"
        )
      })
    })

    test("keeps the mode always allow raised a call's turn to", async () => {
      await withStorage(async (storage) => {
        await startTurn(storage)
        await storage.agents.approvals.request(approvalInput())
        await storage.agents.approvals.request(approvalInput({ id: "apr_2", call: sendReminders }))

        await storage.agents.approvals.decide({ ...decision("approved"), raisedMode: "auto" })
        await storage.agents.approvals.decide({
          ...decision("denied"),
          id: "apr_2",
          raisedMode: "auto",
        })

        const [approved, denied] = (await storage.agents.approvals.list({ projectId })).approvals
        expect(approved?.raisedMode).toBe("auto")
        expect(denied?.raisedMode).toBeUndefined()
      })
    })

    test("stops one turn, or one requester's turns, from resuming", async () => {
      await withStorage(async (storage) => {
        await startTurn(storage)
        await storage.agents.approvals.request(approvalInput())
        await storage.agents.approvals.request(
          approvalInput({ id: "apr_marc", call: sendReminders, requestedBy: marc })
        )
        await storage.agents.approvals.request(
          approvalInput({ id: "apr_decided", call: { ...markPaidCall, actionRunId: "act_2" } })
        )
        await storage.agents.approvals.decide({ ...decision("denied"), id: "apr_decided" })
        const stoppedAt = new Date(t0.getTime() + 5_000)

        const byRequester = await storage.agents.approvals.stop({
          projectId,
          threadId: "thr_1",
          requestedBy: marc,
          stoppedAt,
        })
        const byRun = await storage.agents.approvals.stop({
          projectId,
          threadId: "thr_1",
          runId: "run_1",
          stoppedAt,
        })
        const again = await storage.agents.approvals.stop({
          projectId,
          threadId: "thr_1",
          runId: "run_1",
        })

        expect(byRequester).toEqual({
          cancelled: [expect.objectContaining({ id: "apr_marc", status: "cancelled" })],
          stopped: 1,
        })
        expect(byRun).toEqual({
          cancelled: [expect.objectContaining({ id: "apr_1", status: "cancelled" })],
          stopped: 2,
        })
        expect(again).toEqual({ cancelled: [], stopped: 0 })
        const approvals = (await storage.agents.approvals.list({ projectId })).approvals
        expect(
          approvals.map(({ id, status, turnStoppedAt }) => [id, status, turnStoppedAt])
        ).toEqual([
          ["apr_1", "cancelled", stoppedAt],
          ["apr_decided", "denied", stoppedAt],
          ["apr_marc", "cancelled", stoppedAt],
        ])
      })
    })

    test("a resume does not report a call whose turn was stopped", async () => {
      await withStorage(async (storage) => {
        await startTurn(storage)
        await storage.agents.approvals.request(approvalInput())
        await storage.agents.approvals.decide(decision("denied"))
        await storage.agents.approvals.stop({ projectId, threadId: "thr_1", runId: "run_1" })
        const report = { projectId, threadId: "thr_1", ids: ["apr_1"] }

        const resumed = await storage.agents.approvals.markReported({
          ...report,
          messageId: "msg_resume",
          resuming: true,
        })
        const next = await storage.agents.approvals.markReported({ ...report, messageId: "msg_2" })

        expect(resumed).toEqual([])
        expect(next).toEqual(["apr_1"])
      })
    })

    test("lets one process at a time claim an approved call without its outcome", async () => {
      await withStorage(async (storage) => {
        await startTurn(storage)
        await storage.agents.approvals.request(approvalInput())
        await storage.agents.approvals.decide(decision("approved", t0))
        const claim = (minutes: number, staleMinutes: number) =>
          storage.agents.approvals.claimExecution({
            projectId,
            id: "apr_1",
            claimedAt: new Date(t0.getTime() + minutes * 60_000),
            staleBefore: new Date(t0.getTime() + staleMinutes * 60_000),
          })

        const beforeTheDecisionIsStale = await claim(1, -1)
        const first = await claim(3, 1)
        const racing = await claim(3, 1)
        const afterItGoesStale = await claim(10, 5)
        await storage.agents.approvals.recordOutcome({
          projectId,
          id: "apr_1",
          outcome: ran("act_mark_paid"),
        })
        const afterItRan = await claim(20, 15)

        expect(beforeTheDecisionIsStale).toBeNull()
        expect(first?.executionClaimedAt).toEqual(new Date(t0.getTime() + 3 * 60_000))
        expect(racing).toBeNull()
        expect(afterItGoesStale?.executionClaimedAt).toEqual(new Date(t0.getTime() + 10 * 60_000))
        expect(afterItRan).toBeNull()
      })
    })

    test("lists what a repair pass works on, oldest first, after a cursor", async () => {
      await withStorage(async (storage) => {
        await startTurn(storage)
        const at = (ms: number) => new Date(t0.getTime() + ms)
        const call = (id: string) => ({ ...markPaidCall, actionRunId: `act_${id}` })
        for (const [index, id] of ["pending", "running", "ran", "denied", "reported"].entries()) {
          await storage.agents.approvals.request(
            approvalInput({ id, call: call(id), createdAt: at(index) })
          )
        }
        await storage.agents.approvals.decide({ ...decision("approved", t0), id: "running" })
        await storage.agents.approvals.decide({ ...decision("approved", t0), id: "ran" })
        await storage.agents.approvals.recordOutcome({
          projectId,
          id: "ran",
          outcome: ran("act_ran"),
        })
        await storage.agents.approvals.decide({ ...decision("denied", t0), id: "denied" })
        await storage.agents.approvals.decide({ ...decision("denied", t0), id: "reported" })
        await storage.agents.approvals.markReported({
          projectId,
          threadId: "thr_1",
          ids: ["reported"],
          messageId: "msg_2",
        })
        const list = (
          claimableBefore: Date,
          page: { readonly after?: AgentApprovalCursor; readonly limit?: number } = {}
        ) =>
          storage.agents.approvals
            .listRepairable({ projectId, claimableBefore, limit: 10, ...page })
            .then((approvals) => approvals.map(({ id }) => id))

        expect(await list(at(-1))).toEqual(["running", "ran", "denied"])
        expect(await list(at(-1), { limit: 1 })).toEqual(["running"])
        expect(await list(at(-1), { after: { createdAt: at(1), id: "running" } })).toEqual([
          "ran",
          "denied",
        ])
        await storage.agents.approvals.stop({ projectId, threadId: "thr_1", runId: "run_1" })
        expect(await list(at(-1))).toEqual([])
        expect(await list(at(1))).toEqual(["running"])
        expect(
          await storage.agents.approvals.listRepairable({
            projectId: otherProjectId,
            claimableBefore: at(60_000),
            limit: 10,
          })
        ).toEqual([])
      })
    })

    test("expires the pending approvals whose time ran out, oldest first", async () => {
      await withStorage(async (storage) => {
        await startTurn(storage)
        await storage.agents.approvals.request(approvalInput())
        await storage.agents.approvals.request(
          approvalInput({
            id: "apr_later",
            call: sendReminders,
            createdAt: new Date(t0.getTime() + 1),
            expiresAt: new Date(t0.getTime() + week + 1),
          })
        )
        await storage.agents.approvals.request(
          approvalInput({
            id: "apr_decided",
            call: { ...markPaidCall, actionRunId: "act_decided" },
            expiresAt: new Date(t0.getTime() + 2_000),
          })
        )
        await storage.agents.approvals.decide({ ...decision("denied"), id: "apr_decided" })

        const early = await storage.agents.approvals.expireDue({
          projectId,
          now: new Date(t0.getTime() + week - 1),
        })
        const first = await storage.agents.approvals.expireDue({
          projectId,
          now: new Date(t0.getTime() + week + 1),
          limit: 1,
        })
        const rest = await storage.agents.approvals.expireDue({
          projectId,
          now: new Date(t0.getTime() + week + 1),
        })
        const otherProject = await storage.agents.approvals.expireDue({
          projectId: otherProjectId,
          now: new Date(t0.getTime() + 2 * week),
        })

        expect(early).toEqual([])
        expect(first.map(({ id, status }) => [id, status])).toEqual([["apr_1", "expired"]])
        expect(rest.map(({ id }) => id)).toEqual(["apr_later"])
        expect(otherProject).toEqual([])
        expect(await statuses(storage)).toEqual([
          ["apr_1", "expired"],
          ["apr_decided", "denied"],
          ["apr_later", "expired"],
        ])
      })
    })

    test("keeps each user's default mode and their own choice in each thread", async () => {
      await withStorage(async (storage) => {
        await startTurn(storage)
        const modes = storage.agents.approvalModes

        expect(await modes.getDefault({ projectId, principal: priya })).toBeNull()
        await modes.setDefault({ projectId, principal: priya, mode: "manual" })
        await modes.setDefault({ projectId, principal: priya, mode: "accept-edits" })
        await modes.setForThread({ projectId, threadId: "thr_1", principal: priya, mode: "auto" })
        await modes.setForThread({
          projectId,
          threadId: "thr_1",
          principal: marc,
          mode: "manual",
        })

        expect(await modes.getDefault({ projectId, principal: priya })).toBe("accept-edits")
        expect(await modes.getDefault({ projectId, principal: marc })).toBeNull()
        expect(await modes.getDefault({ projectId: otherProjectId, principal: priya })).toBeNull()
        expect(await modes.getForThread({ projectId, threadId: "thr_1", principal: priya })).toBe(
          "auto"
        )
        expect(await modes.getForThread({ projectId, threadId: "thr_1", principal: marc })).toBe(
          "manual"
        )
        expect(
          await modes.getForThread({ projectId, threadId: "thr_2", principal: priya })
        ).toBeNull()
        await expectAgentError(
          modes.setForThread({ projectId, threadId: "thr_9", principal: priya, mode: "auto" }),
          "thread_not_found"
        )
        await expectAgentError(
          modes.setDefault({ projectId, principal: priya, mode: "ask" as "auto" }),
          "invalid_input"
        )
      })
    })

    test("clears a user's choice in a thread, leaving everyone else's", async () => {
      await withStorage(async (storage) => {
        await startTurn(storage)
        const modes = storage.agents.approvalModes
        await modes.setForThread({ projectId, threadId: "thr_1", principal: priya, mode: "auto" })
        await modes.setForThread({ projectId, threadId: "thr_1", principal: marc, mode: "manual" })

        await modes.setForThread({ projectId, threadId: "thr_1", principal: priya, mode: null })
        await modes.setForThread({ projectId, threadId: "thr_1", principal: priya, mode: null })

        expect(
          await modes.getForThread({ projectId, threadId: "thr_1", principal: priya })
        ).toBeNull()
        expect(await modes.getForThread({ projectId, threadId: "thr_1", principal: marc })).toBe(
          "manual"
        )
        await expectAgentError(
          modes.setForThread({ projectId, threadId: "thr_9", principal: priya, mode: null }),
          "thread_not_found"
        )
      })
    })

    test("keeps a run's approval mode in its spec, and refuses an unknown one", async () => {
      await withStorage(async (storage) => {
        await storage.agents.threads.create({ id: "thr_1", projectId, ownerPrincipal: priya })
        await createTestAgentExecution(storage, { projectId, runId: "run_1" })
        await createTestAgentExecution(storage, { projectId, runId: "run_2" })
        const spec = { model: { provider: "test", modelId: "large" } }

        await expectAgentError(
          storage.agents.runs.create({
            ...runInput("run_2"),
            spec: { ...spec, approvalMode: "ask" as "auto" },
          }),
          "invalid_input"
        )
        const run = await storage.agents.runs.create({
          ...runInput("run_1"),
          spec: { ...spec, approvalMode: "accept-edits" },
        })

        const stored = await storage.agents.runs.getById({ projectId, id: "run_1" })
        expect(run.spec?.approvalMode).toBe("accept-edits")
        expect(stored?.kind === "conversation" ? stored.spec?.approvalMode : null).toBe(
          "accept-edits"
        )
      })
    })
  })
}

function approvalInput(
  overrides: Partial<RequestAgentApprovalInput> = {}
): RequestAgentApprovalInput {
  return {
    id: "apr_1",
    projectId,
    runId: "run_1",
    callerRunId: "run_1",
    executionToken: "token_1",
    requestedBy: priya,
    mode: "manual",
    call: markPaid,
    createdAt: t0,
    expiresAt: new Date(t0.getTime() + week),
    ...overrides,
  }
}

function decision(value: "approved" | "denied", decidedAt = new Date(t0.getTime() + 1_000)) {
  return { projectId, id: "apr_1", decision: value, decidedBy: priya, decidedAt } as const
}

function ran(runId: string) {
  return { kind: "action-run", runId, status: "succeeded" } as const
}

function runInput(id: string) {
  return {
    id,
    projectId,
    executionId: `test_agent_execution:${id}`,
    threadId: "thr_1",
    triggerMessageId: `msg_${id}`,
    spec: { model: { provider: "test", modelId: "large" }, approvalMode: "manual" as const },
    createdAt: t0,
  }
}

async function startTurn(
  storage: AgentApprovalStorageContractStorage,
  options: {
    readonly threadId?: string
    readonly runId?: string
    readonly token?: string
    readonly requestedBy?: Principal
  } = {}
): Promise<void> {
  const threadId = options.threadId ?? "thr_1"
  const runId = options.runId ?? "run_1"
  await storage.agents.threads.create({
    id: threadId,
    projectId,
    ownerPrincipal: options.requestedBy ?? priya,
    createdAt: t0,
  })
  await createTestAgentExecution(storage, { projectId, runId })
  await storage.agents.runs.create({ ...runInput(runId), threadId })
  await storage.agents.runs.start({
    projectId,
    id: runId,
    execution: {
      token: options.token ?? "token_1",
      queueLeaseExpiresAt: new Date(t0.getTime() + 60_000),
    },
    startedAt: t0,
  })
}

async function startChild(storage: AgentApprovalStorageContractStorage): Promise<void> {
  await createTestAgentExecution(storage, {
    projectId,
    runId: "child_1",
    sourceExecutionId: "test_agent_execution:run_1",
  })
  await storage.agents.runs.createSubagent({
    id: "child_1",
    projectId,
    executionId: "test_agent_execution:child_1",
    parentRunId: "run_1",
    parentExecutionToken: "token_1",
    spawnKey: "pay-invoices",
    spec: {
      model: { provider: "test", modelId: "small" },
      task: "Pay the overdue invoices.",
      toolNames: [],
      maxSteps: 10,
      approvalMode: "manual",
    },
    thread: { id: "child_thread_1", create: true },
    trigger: { id: "child_task_1", parts: [{ type: "text", text: "Pay the overdue invoices." }] },
    maxActiveChildren: 4,
    createdAt: t0,
  })
  await storage.agents.runs.start({
    projectId,
    id: "child_1",
    execution: { token: "child_token", queueLeaseExpiresAt: new Date(t0.getTime() + 60_000) },
    startedAt: t0,
  })
}

async function finishTurn(
  storage: AgentApprovalStorageContractStorage,
  status: "succeeded" | "failed" | "cancelled",
  finishReason?: "awaiting_approval"
): Promise<void> {
  await storage.agents.runs.finish(
    status === "succeeded"
      ? { projectId, id: "run_1", executionToken: "token_1", status, finishReason }
      : { projectId, id: "run_1", executionToken: "token_1", status }
  )
}

async function statuses(storage: AgentApprovalStorageContractStorage) {
  const { approvals } = await storage.agents.approvals.list({ projectId })
  return approvals.map((approval) => [approval.id, approval.status])
}

async function expectAgentError(
  promise: Promise<unknown>,
  code: AgentStorageErrorCode
): Promise<void> {
  const error = await promise.catch((caught: unknown) => caught)
  expect(error).toBeInstanceOf(AgentStorageError)
  expect(error).toMatchObject({ code })
}
