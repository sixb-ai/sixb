import { describe, expect, test } from "bun:test"
import type {
  AiCostStorage,
  AiLimitQuantity,
  AiLimitStorage,
  AiLimitSubject,
  AiModelCallCostRecord,
  AiModelCallUsageInput,
  AiUsageStorage,
  AuthStorage,
  ExecutionStorage,
  ReserveAiModelCallInput,
  Storage,
} from "../storage"
import { aiLimitCalendarMonth } from "../storage"

export interface AiLimitStorageContractStorage {
  readonly aiLimits: AiLimitStorage
  readonly aiCosts: AiCostStorage
  readonly aiUsage: AiUsageStorage
  readonly auth: AuthStorage
  readonly executions: ExecutionStorage
  readonly transaction: Storage["transaction"]
}

export interface AiLimitStorageContractSuiteOptions<
  TStorage extends AiLimitStorageContractStorage = AiLimitStorageContractStorage,
> {
  readonly createStorage: () => TStorage | Promise<TStorage>
  readonly setup?: (storage: TStorage) => void | Promise<void>
  readonly cleanup?: (storage: TStorage) => void | Promise<void>
}

const projectId = "ai-limit-contract"
const executionId = "exec_ai_limit_1"

const project: AiLimitSubject = { type: "project" }
const support: AiLimitSubject = { type: "group", id: "support" }
const user = { type: "user" as const, id: "user-1" }

function at(value: string): Date {
  return new Date(value)
}

function reservation(
  callId: string,
  tokens: number,
  overrides: Partial<ReserveAiModelCallInput> = {}
): ReserveAiModelCallInput {
  return {
    projectId,
    executionId,
    attempt: 1,
    callId,
    subjects: [support, user],
    estimates: [{ meter: "tokens.total", amount: tokens }],
    reservedAt: at("2026-08-15T12:00:00.000Z"),
    ...overrides,
  }
}

/** Run the provider-neutral AI policy, period-state, and reservation contract. */
export function runAiLimitStorageContractSuite<TStorage extends AiLimitStorageContractStorage>(
  label: string,
  options: AiLimitStorageContractSuiteOptions<TStorage>
): void {
  const withStorage = async (body: (storage: TStorage) => Promise<void>): Promise<void> => {
    const storage = await options.createStorage()
    try {
      await seedAiLimitStorageContractExecution(storage.auth, storage.executions)
      await options.setup?.(storage)
      await body(storage)
    } finally {
      await options.cleanup?.(storage)
    }
  }

  describe(label, () => {
    test("uses inclusive-start, exclusive-end UTC calendar months", () => {
      expect(aiLimitCalendarMonth(at("2026-12-31T23:59:59.999-05:00"))).toEqual({
        kind: "calendarMonth",
        start: at("2027-01-01T00:00:00.000Z"),
        end: at("2027-02-01T00:00:00.000Z"),
        resetAt: at("2027-02-01T00:00:00.000Z"),
      })
    })

    test("creates, lists, edits, disables, and deletes policies without ambiguous dimensions", async () => {
      await withStorage(async ({ aiLimits }) => {
        const created = await aiLimits.createPolicy({
          id: "project-tokens",
          projectId,
          subject: project,
          limit: { meter: "tokens.total", amount: 100 },
          createdAt: at("2026-08-10T00:00:00.000Z"),
        })
        expect(created).toMatchObject({ enabled: true, period: "calendarMonth" })
        await expect(
          aiLimits.createPolicy({
            id: "duplicate-dimension",
            projectId,
            subject: project,
            limit: { meter: "tokens.total", amount: 200 },
          })
        ).rejects.toMatchObject({ code: "duplicate_policy" })

        await expect(
          aiLimits.updatePolicy({
            projectId,
            id: created.id,
            limit: { meter: "tokens.total", amount: 250 },
            enabled: false,
            updatedAt: at("2026-08-11T00:00:00.000Z"),
          })
        ).resolves.toMatchObject({ limit: { amount: 250 }, enabled: false })
        await expect(aiLimits.listPolicies({ projectId })).resolves.toEqual([])
        await expect(
          aiLimits.listPolicies({ projectId, includeDisabled: true })
        ).resolves.toHaveLength(1)
        await expect(aiLimits.deletePolicy({ projectId, id: created.id })).resolves.toBe(true)
        await expect(aiLimits.deletePolicy({ projectId, id: created.id })).resolves.toBe(false)
        await expect(
          aiLimits.createPolicy({
            id: "cost-out-of-range",
            projectId,
            subject: project,
            limit: {
              meter: "cost.catalogEstimated",
              amount: { currency: "USD", amountNanos: "9223372036854775808" },
            },
          })
        ).rejects.toThrow("exceeds the supported range")
        await expect(
          aiLimits.createPolicy({
            id: "cost-unsupported-currency",
            projectId,
            subject: { type: "group", id: "europe" },
            limit: {
              meter: "cost.catalogEstimated",
              amount: { currency: "EUR", amountNanos: "100" },
            } as unknown as AiLimitQuantity,
          })
        ).rejects.toThrow("catalog-estimated cost currency must be 'USD'")
      })
    })

    test("returns every applicable exhausted policy and the earliest reset", async () => {
      await withStorage(async ({ aiLimits }) => {
        for (const [id, subject, amount] of [
          ["project", project, 10],
          ["support", support, 8],
          ["user", user, 100],
        ] as const) {
          await aiLimits.createPolicy({
            id,
            projectId,
            subject,
            limit: { meter: "tokens.total", amount },
          })
        }
        const result = await aiLimits.reserveModelCall(reservation("denied", 11))
        expect(result).toMatchObject({
          status: "denied",
          exhaustedPolicies: [{ policy: { id: "project" } }, { policy: { id: "support" } }],
          resetAt: at("2026-09-01T00:00:00.000Z"),
        })
        const statuses = await aiLimits.listPolicyStatuses({
          projectId,
          at: at("2026-08-20T00:00:00.000Z"),
          existingGroupIds: [],
        })
        expect(statuses.find((status) => status.policy.id === "support")?.orphaned).toBe(true)
        expect(statuses.every((status) => status.consumption.reserved.amount === 0)).toBe(true)
      })
    })

    test("atomically prevents concurrent reservations from oversubscribing", async () => {
      await withStorage(async ({ aiLimits }) => {
        await aiLimits.createPolicy({
          id: "project",
          projectId,
          subject: project,
          limit: { meter: "tokens.total", amount: 10 },
        })
        const results = await Promise.all([
          aiLimits.reserveModelCall(reservation("call-a", 6)),
          aiLimits.reserveModelCall(reservation("call-b", 6)),
        ])
        expect(results.map((result) => result.status).sort()).toEqual(["denied", "reserved"])
        const [status] = await aiLimits.listPolicyStatuses({ projectId, at: at("2026-08-20Z") })
        expect(status?.consumption).toMatchObject({
          actual: { amount: 0 },
          reserved: { amount: 6 },
          unknown: { amount: 0 },
          remaining: { amount: 4 },
        })
      })
    })

    test("reserves only exact subject-meter policy buckets", async () => {
      await withStorage(async ({ aiLimits }) => {
        await aiLimits.createPolicy({
          id: "project-tokens",
          projectId,
          subject: project,
          limit: { meter: "tokens.total", amount: 100 },
        })
        await aiLimits.createPolicy({
          id: "user-cost",
          projectId,
          subject: user,
          limit: {
            meter: "cost.catalogEstimated",
            amount: { currency: "USD", amountNanos: "100" },
          },
        })
        const result = await aiLimits.reserveModelCall(
          reservation("exact-buckets", 5, {
            estimates: [
              { meter: "tokens.total", amount: 5 },
              {
                meter: "cost.catalogEstimated",
                amount: { currency: "USD", amountNanos: "7" },
              },
            ],
          })
        )
        expect(result).toMatchObject({
          status: "reserved",
          reservation: {
            buckets: [
              { subject: project, estimate: { meter: "tokens.total", amount: 5 } },
              {
                subject: user,
                estimate: {
                  meter: "cost.catalogEstimated",
                  amount: { currency: "USD", amountNanos: "7" },
                },
              },
            ],
          },
        })
      })
    })

    test("replays an identical reservation and rejects a mismatched identity replay", async () => {
      await withStorage(async ({ aiLimits }) => {
        await aiLimits.createPolicy({
          id: "replay-policy",
          projectId,
          subject: project,
          limit: { meter: "tokens.total", amount: 100 },
        })
        const first = await aiLimits.reserveModelCall(reservation("replay", 5))
        const replay = await aiLimits.reserveModelCall(reservation("replay", 5))
        expect(first).toMatchObject({ status: "reserved", created: true })
        expect(replay).toMatchObject({ status: "reserved", created: false })
        await expect(aiLimits.reserveModelCall(reservation("replay", 6))).rejects.toMatchObject({
          code: "reservation_conflict",
        })
      })
    })

    test("does not authorize a terminal reservation replay", async () => {
      await withStorage(async (storage) => {
        const { aiLimits } = storage
        await aiLimits.createPolicy({
          id: "terminal-policy",
          projectId,
          subject: project,
          limit: { meter: "tokens.total", amount: 10 },
        })
        const identity = reservation("terminal-replay", 5)
        await aiLimits.reserveModelCall(identity)
        await recordUsage(storage.aiUsage, "usage-terminal", identity.callId, 3)
        await aiLimits.recordModelCallActuals({
          projectId,
          usageRecordId: "usage-terminal",
        })
        await aiLimits.reconcileModelCall({ ...identity, usageRecordId: "usage-terminal" })
        await expect(aiLimits.reserveModelCall(identity)).resolves.toMatchObject({
          status: "terminal",
          created: false,
          reservation: { state: "reconciled" },
        })
      })
    })

    test("fails closed when an applicable policy has no estimate", async () => {
      await withStorage(async ({ aiLimits }) => {
        await aiLimits.createPolicy({
          id: "tokens",
          projectId,
          subject: project,
          limit: { meter: "tokens.total", amount: 10 },
        })
        const result = await aiLimits.reserveModelCall(
          reservation("missing-estimate", 1, {
            estimates: [
              {
                meter: "cost.catalogEstimated",
                amount: { currency: "USD", amountNanos: "1" },
              },
            ],
          })
        )
        expect(result).toMatchObject({
          status: "unavailable",
          unavailablePolicies: [{ policy: { id: "tokens" } }],
          reasons: ["missingEstimate"],
        })
      })
    })

    test("reconciles estimates to actual usage exactly once", async () => {
      await withStorage(async (storage) => {
        const { aiLimits } = storage
        await aiLimits.createPolicy({
          id: "project",
          projectId,
          subject: project,
          limit: { meter: "tokens.total", amount: 20 },
        })
        await aiLimits.reserveModelCall(reservation("reconcile", 10))
        await recordUsage(storage.aiUsage, "usage-reconcile", "reconcile", 7)
        await aiLimits.recordModelCallActuals({
          projectId,
          usageRecordId: "usage-reconcile",
        })
        const input = {
          projectId,
          executionId,
          attempt: 1,
          callId: "reconcile",
          usageRecordId: "usage-reconcile",
          reconciledAt: at("2026-08-15T12:00:01.000Z"),
        }
        await expect(aiLimits.reconcileModelCall(input)).resolves.toMatchObject({
          state: "reconciled",
          usageRecordId: "usage-reconcile",
        })
        await expect(aiLimits.reconcileModelCall(input)).resolves.toMatchObject({
          state: "reconciled",
        })
        await expect(
          aiLimits.reconcileModelCall({ ...input, usageRecordId: "another-usage" })
        ).rejects.toMatchObject({ code: "reconciliation_conflict" })
        const [status] = await aiLimits.listPolicyStatuses({ projectId, at: input.reconciledAt })
        expect(status?.consumption).toMatchObject({
          actual: { amount: 7 },
          reserved: { amount: 0 },
          unknown: { amount: 0 },
          remaining: { amount: 13 },
        })
      })
    })

    test("rejects a usage record that belongs to another provider call", async () => {
      await withStorage(async (storage) => {
        await storage.aiLimits.createPolicy({
          id: "usage-mismatch-policy",
          projectId,
          subject: project,
          limit: { meter: "tokens.total", amount: 100 },
        })
        const identity = reservation("expected-call", 5)
        await storage.aiLimits.reserveModelCall(identity)
        await recordUsage(storage.aiUsage, "usage-wrong-call", "different-call", 3)
        await expect(
          storage.aiLimits.reconcileModelCall({
            ...identity,
            usageRecordId: "usage-wrong-call",
          })
        ).rejects.toMatchObject({ code: "usage_mismatch" })
      })
    })

    test("conservatively converts a reservation to unknown when actuals are unavailable", async () => {
      await withStorage(async (storage) => {
        await storage.aiLimits.createPolicy({
          id: "tokens",
          projectId,
          subject: project,
          limit: { meter: "tokens.total", amount: 10 },
        })
        const identity = reservation("partial-reconciliation", 5)
        await storage.aiLimits.reserveModelCall(identity)
        await recordUsageInput(storage.aiUsage, {
          id: "usage-partial-reconciliation",
          callId: identity.callId,
          usage: { inputTokens: 3 },
        })
        await storage.aiLimits.recordModelCallActuals({
          projectId,
          usageRecordId: "usage-partial-reconciliation",
        })
        await expect(
          storage.aiLimits.reconcileModelCall({
            ...identity,
            usageRecordId: "usage-partial-reconciliation",
          })
        ).resolves.toMatchObject({ state: "reconciled" })
        const [status] = await storage.aiLimits.listPolicyStatuses({
          projectId,
          at: identity.reservedAt,
        })
        expect(status).toMatchObject({
          accountingStatus: "unavailable",
          consumption: { reserved: { amount: 0 }, unknown: { amount: 5 } },
        })
      })
    })

    test("fails closed when historical token accounting is incomplete", async () => {
      await withStorage(async (storage) => {
        await recordUsageInput(storage.aiUsage, {
          id: "usage-partial",
          callId: "partial",
          usage: { inputTokens: 3 },
        })
        await storage.aiLimits.createPolicy({
          id: "tokens",
          projectId,
          subject: project,
          limit: { meter: "tokens.total", amount: 10 },
        })
        const [status] = await storage.aiLimits.listPolicyStatuses({
          projectId,
          at: at("2026-08-15T12:00:01.000Z"),
        })
        expect(status).toMatchObject({
          accountingStatus: "unavailable",
          consumption: { actual: { amount: 0 } },
        })
        await expect(
          storage.aiLimits.reserveModelCall(reservation("after-partial", 1))
        ).resolves.toMatchObject({
          status: "unavailable",
          reasons: ["incompleteAccounting"],
        })
      })
    })

    test("charges actuals to the ledger occurrence month", async () => {
      await withStorage(async (storage) => {
        await storage.aiLimits.createPolicy({
          id: "tokens",
          projectId,
          subject: project,
          limit: { meter: "tokens.total", amount: 20 },
        })
        const identity = reservation("month-boundary", 10, {
          reservedAt: at("2026-08-31T23:59:59.000Z"),
        })
        await storage.aiLimits.reserveModelCall(identity)
        await recordUsage(storage.aiUsage, "usage-month-boundary", "month-boundary", 7, {
          occurredAt: at("2026-09-01T00:00:00.000Z"),
        })
        await storage.aiLimits.recordModelCallActuals({
          projectId,
          usageRecordId: "usage-month-boundary",
        })
        await expect(
          storage.aiLimits.reconcileModelCall({
            ...identity,
            usageRecordId: "usage-month-boundary",
            reconciledAt: at("2026-09-01T00:00:01.000Z"),
          })
        ).resolves.toMatchObject({ state: "reconciled" })
        const [august] = await storage.aiLimits.listPolicyStatuses({
          projectId,
          at: at("2026-08-31T23:59:59.999Z"),
        })
        const [september] = await storage.aiLimits.listPolicyStatuses({
          projectId,
          at: at("2026-09-01T00:00:00.000Z"),
        })
        expect(august?.consumption).toMatchObject({
          actual: { amount: 0 },
          reserved: { amount: 0 },
        })
        expect(september?.consumption).toMatchObject({
          actual: { amount: 7 },
          remaining: { amount: 13 },
        })
      })
    })

    test("holds unknown capacity until it is reconciled", async () => {
      await withStorage(async (storage) => {
        const { aiLimits } = storage
        await aiLimits.createPolicy({
          id: "project",
          projectId,
          subject: project,
          limit: { meter: "tokens.total", amount: 10 },
        })
        const identity = reservation("unknown", 8)
        await aiLimits.reserveModelCall(identity)
        await aiLimits.markReservationUnknown({ ...identity, markedAt: at("2026-08-15T12:01Z") })
        let [status] = await aiLimits.listPolicyStatuses({ projectId, at: identity.reservedAt })
        expect(status?.consumption).toMatchObject({
          reserved: { amount: 0 },
          unknown: { amount: 8 },
          remaining: { amount: 2 },
        })
        await recordUsage(storage.aiUsage, "usage-unknown", identity.callId, 3)
        await aiLimits.recordModelCallActuals({ projectId, usageRecordId: "usage-unknown" })
        await aiLimits.reconcileModelCall({
          ...identity,
          usageRecordId: "usage-unknown",
          reconciledAt: at("2026-08-15T12:02Z"),
        })
        ;[status] = await aiLimits.listPolicyStatuses({ projectId, at: identity.reservedAt })
        expect(status?.consumption).toMatchObject({
          actual: { amount: 3 },
          unknown: { amount: 0 },
          remaining: { amount: 7 },
        })
      })
    })

    test("counts usage recorded before a policy is created and preserves it across recreation", async () => {
      await withStorage(async (storage) => {
        const identity = reservation("before-policy", 10)
        await recordUsage(storage.aiUsage, "usage-before-policy", "before-policy", 7)
        await storage.aiLimits.createPolicy({
          id: "created-mid-month",
          projectId,
          subject: project,
          limit: { meter: "tokens.total", amount: 10 },
        })
        let [status] = await storage.aiLimits.listPolicyStatuses({
          projectId,
          at: identity.reservedAt,
        })
        expect(status?.consumption.actual).toEqual({ meter: "tokens.total", amount: 7 })
        await storage.aiLimits.updatePolicy({
          projectId,
          id: "created-mid-month",
          limit: { meter: "tokens.total", amount: 20 },
        })
        await storage.aiLimits.deletePolicy({ projectId, id: "created-mid-month" })
        await storage.aiLimits.createPolicy({
          id: "recreated",
          projectId,
          subject: project,
          limit: { meter: "tokens.total", amount: 30 },
        })
        ;[status] = await storage.aiLimits.listPolicyStatuses({
          projectId,
          at: identity.reservedAt,
        })
        expect(status?.consumption).toMatchObject({
          actual: { amount: 7 },
          remaining: { amount: 23 },
        })
      })
    })

    test("derives each subject's actuals from immutable execution and usage attribution", async () => {
      await withStorage(async (storage) => {
        const engineering = { type: "group" as const, id: "engineering" }
        const serviceAccount = { type: "serviceAccount" as const, id: "automation" }
        await recordUsage(storage.aiUsage, "usage-all-subjects", "all-subjects", 7, {
          requesterGroupIds: ["support", "engineering"],
        })

        const serviceExecutionId = "exec_ai_limit_service"
        await seedPrincipalExecution(
          storage.auth,
          storage.executions,
          serviceExecutionId,
          serviceAccount
        )
        await recordUsage(storage.aiUsage, "usage-service-account", "service-account", 3, {
          executionId: serviceExecutionId,
          requesterGroupIds: [],
        })

        for (const [id, subject] of [
          ["project-subject", project],
          ["support-subject", support],
          ["engineering-subject", engineering],
          ["user-subject", user],
          ["service-account-subject", serviceAccount],
        ] as const) {
          await storage.aiLimits.createPolicy({
            id,
            projectId,
            subject,
            limit: { meter: "tokens.total", amount: 20 },
          })
        }
        const august = await storage.aiLimits.listPolicyStatuses({
          projectId,
          at: at("2026-08-31T23:59:59.999Z"),
        })
        expect(
          Object.fromEntries(
            august.map((status) => [status.policy.id, status.consumption.actual.amount])
          )
        ).toEqual({
          "engineering-subject": 7,
          "project-subject": 10,
          "service-account-subject": 3,
          "support-subject": 7,
          "user-subject": 7,
        })
        const september = await storage.aiLimits.listPolicyStatuses({
          projectId,
          at: at("2026-09-01T00:00:00.000Z"),
        })
        expect(september.map((status) => status.consumption.actual.amount)).toEqual([0, 0, 0, 0, 0])
      })
    })

    test("derives catalog-estimated cost from the immutable valuation ledger", async () => {
      await withStorage(async (storage) => {
        await storage.aiLimits.createPolicy({
          id: "cost",
          projectId,
          subject: project,
          limit: {
            meter: "cost.catalogEstimated",
            amount: { currency: "USD", amountNanos: "1000000000" },
          },
        })
        const identity = reservation("cost", 1, {
          estimates: [
            {
              meter: "cost.catalogEstimated",
              amount: { currency: "USD", amountNanos: "250000000" },
            },
          ],
        })
        const result = await storage.aiLimits.reserveModelCall(identity)
        expect(result.status).toBe("reserved")
        await recordUsage(storage.aiUsage, "usage-cost", "cost", 1)
        await storage.aiCosts.recordModelCallCost(ratedCost("usage-cost", "250000000"))
        await storage.aiLimits.recordModelCallActuals({
          projectId,
          usageRecordId: "usage-cost",
        })
        await expect(
          storage.aiLimits.reconcileModelCall({
            ...identity,
            usageRecordId: "usage-cost",
          })
        ).resolves.toMatchObject({ state: "reconciled" })
        const [status] = await storage.aiLimits.listPolicyStatuses({
          projectId,
          at: at("2026-08-15T12:00:00.000Z"),
        })
        expect(status).toMatchObject({
          accountingStatus: "complete",
          consumption: {
            actual: { amount: { currency: "USD", amountNanos: "250000000" } },
            reserved: { amount: { currency: "USD", amountNanos: "0" } },
            remaining: { amount: { currency: "USD", amountNanos: "750000000" } },
          },
        })
      })
    })

    test("fails cost admission closed until every applicable call is valued", async () => {
      await withStorage(async (storage) => {
        await recordUsage(storage.aiUsage, "usage-unvalued", "unvalued", 1)
        await storage.aiLimits.createPolicy({
          id: "cost",
          projectId,
          subject: project,
          limit: {
            meter: "cost.catalogEstimated",
            amount: { currency: "USD", amountNanos: "1000000000" },
          },
        })
        await expect(
          storage.aiLimits.reserveModelCall(
            reservation("after-unvalued", 1, {
              estimates: [
                {
                  meter: "cost.catalogEstimated",
                  amount: { currency: "USD", amountNanos: "1" },
                },
              ],
            })
          )
        ).resolves.toMatchObject({
          status: "unavailable",
          reasons: ["incompleteAccounting"],
        })

        await storage.aiCosts.recordModelCallCost(unpriceableCost("usage-unvalued"))
        await expect(
          storage.aiLimits.reserveModelCall(
            reservation("after-unpriceable", 1, {
              estimates: [
                {
                  meter: "cost.catalogEstimated",
                  amount: { currency: "USD", amountNanos: "1" },
                },
              ],
            })
          )
        ).resolves.toMatchObject({
          status: "unavailable",
          reasons: ["incompleteAccounting"],
        })
      })
    })

    test("rolls policy and reservation state back with the root storage transaction", async () => {
      await withStorage(async (storage) => {
        await expect(
          storage.transaction(async (tx) => {
            const limits = tx.aiLimits
            if (!limits) throw new Error("Expected AI limit storage in transaction")
            await limits.createPolicy({
              id: "rolled-back",
              projectId,
              subject: project,
              limit: { meter: "tokens.total", amount: 10 },
            })
            await limits.reserveModelCall(reservation("rolled-back", 5))
            throw new Error("rollback")
          })
        ).rejects.toThrow("rollback")
        await expect(
          storage.aiLimits.getPolicy({ projectId, id: "rolled-back" })
        ).resolves.toBeNull()
        await expect(
          storage.aiLimits.reserveModelCall(reservation("after-rollback", 10))
        ).resolves.toEqual({ status: "notRequired" })
      })
    })

    test("rolls ledger accounting and reconciliation back together", async () => {
      await withStorage(async (storage) => {
        await storage.aiLimits.createPolicy({
          id: "transactional-accounting",
          projectId,
          subject: project,
          limit: { meter: "tokens.total", amount: 10 },
        })
        const identity = reservation("transactional-accounting", 5)
        await storage.aiLimits.reserveModelCall(identity)

        await expect(
          storage.transaction(async (tx) => {
            if (!tx.aiUsage || !tx.aiLimits) {
              throw new Error("Expected AI accounting and limit storage in transaction")
            }
            await recordUsage(tx.aiUsage, "usage-transactional-accounting", identity.callId, 3)
            await tx.aiLimits.recordModelCallActuals({
              projectId,
              usageRecordId: "usage-transactional-accounting",
            })
            await tx.aiLimits.reconcileModelCall({
              ...identity,
              usageRecordId: "usage-transactional-accounting",
            })
            throw new Error("rollback accounting")
          })
        ).rejects.toThrow("rollback accounting")

        await expect(
          storage.aiUsage.summarizeExecution({ projectId, executionId })
        ).resolves.toMatchObject({ modelCallCount: 0 })
        const [status] = await storage.aiLimits.listPolicyStatuses({
          projectId,
          at: identity.reservedAt,
        })
        expect(status?.consumption).toMatchObject({
          actual: { amount: 0 },
          reserved: { amount: 5 },
          remaining: { amount: 5 },
        })
      })
    })
  })
}

export async function seedAiLimitStorageContractExecution(
  auth: AuthStorage,
  executions: ExecutionStorage
): Promise<void> {
  if (!(await auth.users.getById({ projectId, id: user.id }))) {
    await auth.users.create({
      id: user.id,
      projectId,
      email: "ai-limit-user@example.test",
      createdAt: at("2026-08-01T00:00:00.000Z"),
      updatedAt: at("2026-08-01T00:00:00.000Z"),
    })
  }
  if (await executions.getById({ projectId, id: executionId })) return
  const primitive = { kind: "workflow" as const, id: "ai-limit-contract", runId: executionId }
  await executions.create({
    id: executionId,
    projectId,
    requestedBy: user,
    executor: { type: "primitive", kind: primitive.kind, runId: primitive.runId },
    source: { type: "event", eventId: `test_event:${executionId}` },
    correlationId: `test_correlation:${executionId}`,
    authorizationRef: { type: "trustedPrimitive", primitive },
  })
}

async function seedPrincipalExecution(
  auth: AuthStorage,
  executions: ExecutionStorage,
  id: string,
  principal:
    | { readonly type: "user"; readonly id: string }
    | { readonly type: "serviceAccount"; readonly id: string }
): Promise<void> {
  if (principal.type === "serviceAccount") {
    if (!(await auth.serviceAccounts.getById({ projectId, id: principal.id }))) {
      await auth.serviceAccounts.create({
        id: principal.id,
        projectId,
        name: "AI limit contract service account",
        createdAt: at("2026-08-01T00:00:00.000Z"),
        updatedAt: at("2026-08-01T00:00:00.000Z"),
      })
    }
  }
  if (await executions.getById({ projectId, id })) return
  const primitive = { kind: "workflow" as const, id: "ai-limit-contract", runId: id }
  await executions.create({
    id,
    projectId,
    requestedBy: principal,
    executor: { type: "primitive", kind: primitive.kind, runId: primitive.runId },
    source: { type: "event", eventId: `test_event:${id}` },
    correlationId: `test_correlation:${id}`,
    authorizationRef: { type: "trustedPrimitive", primitive },
  })
}

async function recordUsage(
  storage: AiUsageStorage,
  id: string,
  callId: string,
  totalTokens: number,
  overrides: {
    readonly executionId?: string
    readonly requesterGroupIds?: readonly string[]
    readonly occurredAt?: Date
  } = {}
): Promise<void> {
  await recordUsageInput(storage, {
    id,
    callId,
    executionId: overrides.executionId,
    requesterGroupIds: overrides.requesterGroupIds,
    occurredAt: overrides.occurredAt,
    usage: { inputTokens: totalTokens, outputTokens: 0 },
  })
}

async function recordUsageInput(
  storage: AiUsageStorage,
  input: {
    readonly id: string
    readonly callId: string
    readonly executionId?: string
    readonly requesterGroupIds?: readonly string[]
    readonly occurredAt?: Date
    readonly usage: AiModelCallUsageInput
  }
): Promise<void> {
  await storage.recordModelCall({
    id: input.id,
    projectId,
    executionId: input.executionId ?? executionId,
    attempt: 1,
    callId: input.callId,
    requesterGroupIds: input.requesterGroupIds ?? ["support"],
    providerId: "test",
    requestedModelId: "test/model",
    responseId: `response:${input.callId}`,
    usage: input.usage,
    occurredAt: input.occurredAt ?? at("2026-08-15T12:00:00.500Z"),
    recordedAt: at("2026-08-15T12:00:00.600Z"),
  })
}

function ratedCost(usageRecordId: string, amountNanos: string): AiModelCallCostRecord {
  return {
    projectId,
    usageRecordId,
    status: "rated",
    billingIdentity: { providerId: "test", modelId: "test/model" },
    pricingContext: {},
    priceSource: {
      sourceId: "test-catalog",
      sourceEntryId: "test/model",
      sourceVersion: "v1",
      sourceUrl: "https://example.test/catalog.json",
      observedAt: at("2026-08-01T00:00:00.000Z"),
    },
    money: { currency: "USD", amountNanos },
    components: [
      {
        meter: "tokens.input.total",
        quantity: "1",
        rateAmountNanosPerMillion: "250000000000000",
        chargeAmountNanos: amountNanos,
      },
      {
        meter: "tokens.output.total",
        quantity: "0",
        rateAmountNanosPerMillion: "0",
        chargeAmountNanos: "0",
      },
    ],
    ratedAt: at("2026-08-15T12:00:00.700Z"),
  }
}

function unpriceableCost(usageRecordId: string): AiModelCallCostRecord {
  return {
    projectId,
    usageRecordId,
    status: "unpriceable",
    billingIdentity: { providerId: "test", modelId: "test/model" },
    pricingContext: {},
    priceSource: {
      sourceId: "test-catalog",
      sourceEntryId: "test/model",
      sourceVersion: "v1",
      sourceUrl: "https://example.test/catalog.json",
      observedAt: at("2026-08-01T00:00:00.000Z"),
    },
    reason: "unsupportedPricingDimension",
    ratedAt: at("2026-08-15T12:00:00.700Z"),
  }
}
