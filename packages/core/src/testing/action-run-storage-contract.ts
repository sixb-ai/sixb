import { describe, expect, test } from "bun:test"
import type {
  ActionRunFailure,
  ActionRunPhase,
  ActionRunRecord,
  RecordActionRunInput,
  Storage,
} from "../storage"
import { ActionRunError } from "../storage"
import {
  createTestActionExecution,
  createTestActionRunRecord,
  recordTestActionRun,
  type TestActionRunInput,
} from "./action-execution"

export type ActionRunStorageContractStorage = Storage & {
  readonly actionRuns: NonNullable<Storage["actionRuns"]>
}

export interface ActionRunStorageContractSuiteOptions<
  TStorage extends ActionRunStorageContractStorage = ActionRunStorageContractStorage,
> {
  readonly createStorage: () => TStorage | Promise<TStorage>
  readonly cleanup?: (storage: TStorage) => void | Promise<void>
}

const projectId = "action-run-contract"
const startedAt = new Date("2026-04-29T10:00:00.000Z")
const finishedAt = new Date("2026-04-29T10:00:03.842Z")

function failure<TPhase extends ActionRunPhase>(
  runId: string,
  phase: TPhase,
  message: string
): ActionRunFailure<TPhase> {
  return {
    code: "action.phase_failed",
    message,
    retryable: false,
    at: finishedAt.toISOString(),
    details: { actionId: "createInvoice", runId, phase },
  }
}

type RunOverrides = Partial<
  Pick<
    TestActionRunInput,
    "actionId" | "subject" | "phase" | "startedAt" | "finishedAt" | "writeback"
  >
> &
  (
    | { readonly status?: "succeeded"; readonly error?: never }
    | { readonly status: "failed"; readonly error: ActionRunFailure }
  )

function run(id: string, overrides: RunOverrides = {}): TestActionRunInput {
  return {
    id,
    projectId,
    actionId: "createInvoice",
    subject: { kind: "none" },
    params: { amount: 42 },
    idempotencyKey: `action:${projectId}:${id}`,
    startedAt,
    finishedAt,
    ...overrides,
  }
}

/** Runs the record-once Action run contract against one complete storage provider. */
export function runActionRunStorageContractSuite<TStorage extends ActionRunStorageContractStorage>(
  label: string,
  options: ActionRunStorageContractSuiteOptions<TStorage>
): void {
  const withStorage = async (body: (storage: TStorage) => Promise<void>): Promise<void> => {
    const storage = await options.createStorage()
    try {
      await body(storage)
    } finally {
      await options.cleanup?.(storage)
    }
  }

  describe(label, () => {
    test("records a terminal run once, and reads it back detached", async () => {
      await withStorage(async (storage) => {
        const input = await createTestActionRunRecord(
          storage.executions,
          run("act_1", {
            subject: { kind: "object", objectTypeId: "Opportunity", primaryId: "opp-1" },
            writeback: {
              status: "succeeded",
              completedAt: new Date("2026-04-29T10:00:01.000Z"),
              result: { externalInvoiceId: "ext_1" },
            },
          })
        )

        const recorded = await storage.actionRuns.record(input)
        const expected: ActionRunRecord = {
          id: "act_1",
          projectId,
          executionId: "test_action_execution:act_1",
          actionId: "createInvoice",
          subject: { kind: "object", objectTypeId: "Opportunity", primaryId: "opp-1" },
          status: "succeeded",
          phase: "commit",
          startedAt,
          finishedAt,
          params: { amount: 42 },
          idempotencyKey: `action:${projectId}:act_1`,
          writeback: {
            status: "succeeded",
            completedAt: new Date("2026-04-29T10:00:01.000Z"),
            result: { externalInvoiceId: "ext_1" },
          },
        }
        expect(recorded).toEqual(expected)
        ;(recorded.params as { amount: number }).amount = 1
        await expect(storage.actionRuns.getById({ projectId, id: "act_1" })).resolves.toEqual(
          expected
        )

        await expect(storage.actionRuns.record(input)).rejects.toBeInstanceOf(ActionRunError)
        await expect(
          storage.actionRuns.record({ ...input, id: "act_2", idempotencyKey: "act_2" })
        ).rejects.toBeInstanceOf(ActionRunError)
        await expect(storage.actionRuns.getById({ projectId, id: "act_2" })).resolves.toBeNull()
      })
    })

    test("requires the trusted execution created for the run", async () => {
      await withStorage(async (storage) => {
        const input = await createTestActionRunRecord(storage.executions, run("act_owned"))
        await expect(
          storage.actionRuns.record({ ...input, executionId: "missing" })
        ).rejects.toThrow("does not authorize Action run")

        const otherAction = await createTestActionExecution(storage.executions, {
          projectId,
          actionId: "otherAction",
          runId: "act_other",
        })
        await expect(
          storage.actionRuns.record({ ...input, executionId: otherAction })
        ).rejects.toThrow("does not authorize Action run")
        await expect(storage.actionRuns.getById({ projectId, id: "act_owned" })).resolves.toBeNull()
      })
    })

    test("refuses a record a run cannot end with", async () => {
      await withStorage(async (storage) => {
        const succeeded = await createTestActionRunRecord(storage.executions, run("act_invalid"))
        const writebackFailure = failure("act_invalid", "writeback", "Upstream rejected it")
        const invalid: readonly RecordActionRunInput[] = [
          { ...succeeded, phase: "effects" },
          { ...succeeded, status: "failed", phase: "commit", error: writebackFailure },
          {
            ...succeeded,
            status: "failed",
            phase: "writeback",
            error: failure("another-run", "writeback", "Upstream rejected it"),
          },
          { ...succeeded, finishedAt: new Date(startedAt.getTime() - 1) },
        ]
        for (const input of invalid) {
          await expect(storage.actionRuns.record(input)).rejects.toThrow()
        }
        await expect(
          storage.actionRuns.getById({ projectId, id: "act_invalid" })
        ).resolves.toBeNull()
      })
    })

    test("records a failure with the phase it ended in", async () => {
      await withStorage(async (storage) => {
        const error = failure("act_failed", "writeback", "TeamLeader API returned 503")
        const recorded = await recordTestActionRun(
          storage,
          run("act_failed", {
            status: "failed",
            error,
            writeback: { status: "failed", completedAt: finishedAt, error },
          })
        )

        expect(recorded).toMatchObject({ status: "failed", phase: "writeback", error })
        await expect(
          storage.actionRuns.getById({ projectId, id: "act_failed" })
        ).resolves.toMatchObject({
          status: "failed",
          phase: "writeback",
          error,
          writeback: { status: "failed", error },
        })
      })
    })

    test("records the effects of a run that committed, once", async () => {
      await withStorage(async (storage) => {
        await recordTestActionRun(storage, run("act_effects"))
        const error = failure("act_effects", "effects", "Slack timed out")
        const completedAt = new Date("2026-04-29T10:00:05.000Z")

        const recorded = await storage.actionRuns.recordEffects({
          id: "act_effects",
          projectId,
          status: "failed",
          completedAt,
          error,
        })
        expect(recorded).toMatchObject({
          status: "succeeded",
          phase: "effects",
          effects: { status: "failed", completedAt, error },
        })
        expect(recorded.error).toBeUndefined()

        // The same outcome again changes nothing, its completion time included.
        await expect(
          storage.actionRuns.recordEffects({
            id: "act_effects",
            projectId,
            status: "failed",
            completedAt: new Date("2026-04-29T10:00:06.000Z"),
            error,
          })
        ).resolves.toEqual(recorded)
        await expect(
          storage.actionRuns.recordEffects({ id: "act_effects", projectId, status: "succeeded" })
        ).rejects.toBeInstanceOf(ActionRunError)
        await expect(storage.actionRuns.getById({ projectId, id: "act_effects" })).resolves.toEqual(
          recorded
        )
      })
    })

    test("records effects only on a succeeded run in its commit phase", async () => {
      await withStorage(async (storage) => {
        await recordTestActionRun(storage, run("act_no_edits", { phase: "writeback" }))
        await recordTestActionRun(
          storage,
          run("act_rejected", {
            status: "failed",
            error: failure("act_rejected", "commit", "Commit failed"),
          })
        )

        for (const id of ["act_no_edits", "act_rejected", "act_missing"]) {
          await expect(
            storage.actionRuns.recordEffects({ id, projectId, status: "succeeded" })
          ).rejects.toBeInstanceOf(ActionRunError)
        }
        await expect(
          storage.actionRuns.getById({ projectId, id: "act_no_edits" })
        ).resolves.toMatchObject({ phase: "writeback" })
      })
    })

    test("lists runs with filters, in start order, by page", async () => {
      await withStorage(async (storage) => {
        const at = (minute: number) => new Date(Date.UTC(2026, 3, 29, 10, minute))
        await recordTestActionRun(
          storage,
          run("act_1", {
            subject: { kind: "object", objectTypeId: "Opportunity", primaryId: "opp-1" },
            startedAt: at(0),
            finishedAt: at(1),
            status: "failed",
            error: failure("act_1", "validation", "Invalid amount"),
          })
        )
        await recordTestActionRun(
          storage,
          run("act_2", {
            subject: { kind: "object", objectTypeId: "Opportunity", primaryId: "opp-2" },
            startedAt: at(10),
            finishedAt: at(11),
          })
        )
        await recordTestActionRun(
          storage,
          run("act_3", { actionId: "closeOpportunity", startedAt: at(20), finishedAt: at(21) })
        )

        const succeeded = await storage.actionRuns.list({
          projectId,
          actionId: "createInvoice",
          statuses: ["succeeded"],
          startedAfter: at(5),
          limit: 1,
        })
        expect(succeeded).toMatchObject({ total: 1, hasMore: false })
        expect(succeeded.runs.map((recorded) => recorded.id)).toEqual(["act_2"])

        const all = await storage.actionRuns.list({ projectId, order: "asc", limit: 2 })
        expect(all).toMatchObject({ total: 3, hasMore: true })
        expect(all.runs.map((recorded) => recorded.id)).toEqual(["act_1", "act_2"])

        const latest = await storage.actionRuns.list({ projectId, startedBefore: at(15) })
        expect(latest.runs.map((recorded) => recorded.id)).toEqual(["act_2", "act_1"])

        const forObject = await storage.actionRuns.list({
          projectId,
          objectTypeId: "Opportunity",
          primaryId: "opp-1",
        })
        expect(forObject.runs.map((recorded) => recorded.id)).toEqual(["act_1"])
      })
    })

    test("drops a record written in a transaction that rolls back", async () => {
      await withStorage(async (storage) => {
        const input = await createTestActionRunRecord(storage.executions, run("act_rolled_back"))
        await expect(
          storage.transaction(async (tx) => {
            await tx.actionRuns?.record(input)
            throw new Error("rollback")
          })
        ).rejects.toThrow("rollback")
        await expect(
          storage.actionRuns.getById({ projectId, id: "act_rolled_back" })
        ).resolves.toBeNull()

        await storage.transaction(async (tx) => {
          await tx.actionRuns?.record(input)
        })
        await expect(
          storage.actionRuns.getById({ projectId, id: "act_rolled_back" })
        ).resolves.toMatchObject({ status: "succeeded" })
      })
    })
  })
}
