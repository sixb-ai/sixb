import { describe, expect, test } from "bun:test"
import {
  type AiUsageStorage,
  AiUsageStorageError,
  type RecordAiModelCallInput,
} from "../storage/ai-usage"
import type { ExecutionStorage } from "../storage/executions"

export interface AiUsageStorageContractSuiteOptions<
  TStorage extends AiUsageStorage = AiUsageStorage,
> {
  /** Factory that returns an isolated AI usage store for each test. */
  readonly createStorage: () => TStorage | Promise<TStorage>
  readonly setup?: (storage: TStorage) => void | Promise<void>
  readonly cleanup?: (storage: TStorage) => void | Promise<void>
}

const projectId = "contract-project"
const agentExecutionId = "exec_agent_1"
const otherAgentExecutionId = "exec_agent_2"
const workflowExecutionId = "exec_workflow_1"

function at(value: string): Date {
  return new Date(value)
}

function modelCallInput(overrides: Partial<RecordAiModelCallInput> = {}): RecordAiModelCallInput {
  return {
    id: "usage_1",
    projectId,
    executionId: agentExecutionId,
    attempt: 1,
    callId: "call_1",
    requesterGroupIds: ["support", "engineering"],
    providerId: "gateway",
    requestedModelId: "openai/gpt-5",
    responseModelId: "gpt-5-2026-06-01",
    responseId: "response_1",
    usage: {
      inputTokens: 12,
      outputTokens: 8,
      uncachedInputTokens: 9,
      cacheReadInputTokens: 3,
      cacheWriteInputTokens: 1,
      textOutputTokens: 6,
      reasoningOutputTokens: 2,
    },
    modelDefinition: {
      kind: "language",
      providerId: "gateway",
      modelId: "openai/gpt-5",
      contextWindow: 400_000,
      capabilities: { reasoning: true, localTools: true },
      pricing: {
        currency: "USD",
        unit: "million-tokens",
        input: "1.25",
        output: "10",
      },
    },
    cost: {
      status: "reported",
      money: { currency: "USD", amountNanos: "12345" },
      providerId: "gateway",
    },
    route: { providerId: "openai", modelId: "gpt-5-2026-06-01" },
    rawUsage: { input_tokens: 12, output_tokens: 8 },
    occurredAt: at("2026-06-23T10:00:00.000Z"),
    recordedAt: at("2026-06-23T10:00:01.000Z"),
    ...overrides,
  }
}

/** Runs the provider-neutral model-call ledger contract against one storage implementation. */
export function runAiUsageStorageContractSuite<TStorage extends AiUsageStorage>(
  label: string,
  options: AiUsageStorageContractSuiteOptions<TStorage>
): void {
  const withStorage = async (body: (storage: TStorage) => Promise<void>): Promise<void> => {
    const storage = await options.createStorage()
    try {
      await options.setup?.(storage)
      await body(storage)
    } finally {
      await options.cleanup?.(storage)
    }
  }

  describe(label, () => {
    test("records normalized usage and one canonical row per requester group", async () => {
      await withStorage(async (storage) => {
        const result = await storage.recordModelCall(
          modelCallInput({
            requesterGroupIds: ["support", "engineering", "support"],
          })
        )

        expect(result.created).toBe(true)
        expect(result.record).toEqual({
          ...modelCallInput(),
          requesterGroupIds: ["engineering", "support"],
          usage: {
            ...modelCallInput().usage,
            totalTokens: 20,
            reportingStatus: "complete",
          },
          recordedAt: at("2026-06-23T10:00:01.000Z"),
        })
      })
    })

    test("returns the existing record when the idempotency key is replayed", async () => {
      await withStorage(async (storage) => {
        const first = await storage.recordModelCall(modelCallInput())
        const replay = await storage.recordModelCall(
          modelCallInput({
            id: "ignored_retry_id",
            requesterGroupIds: ["different-group"],
            usage: { inputTokens: 999, outputTokens: 1 },
          })
        )

        expect(first.created).toBe(true)
        expect(replay.created).toBe(false)
        expect(replay.record).toEqual(first.record)
      })
    })

    test("allows one generation call id to contain multiple billable responses", async () => {
      await withStorage(async (storage) => {
        await storage.recordModelCall(modelCallInput())
        await storage.recordModelCall(
          modelCallInput({
            id: "usage_2",
            responseId: "response_2",
            usage: {
              inputTokens: 4,
              outputTokens: 6,
              uncachedInputTokens: 4,
              cacheReadInputTokens: 0,
              cacheWriteInputTokens: 2,
              textOutputTokens: 5,
              reasoningOutputTokens: 1,
            },
          })
        )

        await expect(
          storage.summarizeExecution({ projectId, executionId: agentExecutionId })
        ).resolves.toEqual({
          modelCallCount: 2,
          usage: {
            inputTokens: 16,
            outputTokens: 14,
            totalTokens: 30,
            uncachedInputTokens: 13,
            cacheReadInputTokens: 3,
            cacheWriteInputTokens: 3,
            textOutputTokens: 11,
            reasoningOutputTokens: 3,
            reportingStatus: "complete",
          },
        })
      })
    })

    test("bills the same call and response IDs again on a later delivery attempt", async () => {
      // Regression guard: remove `attempt` from a provider's idempotency key/query/index and the
      // second append collapses into the first, making the aggregate assertions fail.
      await withStorage(async (storage) => {
        await storage.recordModelCall(modelCallInput())
        await storage.recordModelCall(
          modelCallInput({
            id: "usage_2",
            attempt: 2,
            usage: {
              inputTokens: 4,
              outputTokens: 6,
              uncachedInputTokens: 4,
              cacheReadInputTokens: 0,
              cacheWriteInputTokens: 2,
              textOutputTokens: 5,
              reasoningOutputTokens: 1,
            },
          })
        )

        await expect(
          storage.summarizeExecution({ projectId, executionId: agentExecutionId })
        ).resolves.toEqual({
          modelCallCount: 2,
          usage: {
            inputTokens: 16,
            outputTokens: 14,
            totalTokens: 30,
            uncachedInputTokens: 13,
            cacheReadInputTokens: 3,
            cacheWriteInputTokens: 3,
            textOutputTokens: 11,
            reasoningOutputTokens: 3,
            reportingStatus: "complete",
          },
        })
      })
    })

    test("does not count concurrent idempotent appends twice", async () => {
      await withStorage(async (storage) => {
        const results = await Promise.all([
          storage.recordModelCall(modelCallInput()),
          storage.recordModelCall(modelCallInput({ id: "usage_retry" })),
        ])

        expect(results.map((result) => result.created).sort()).toEqual([false, true])
        await expect(
          storage.summarizeExecution({ projectId, executionId: agentExecutionId })
        ).resolves.toEqual({
          modelCallCount: 1,
          usage: {
            inputTokens: 12,
            outputTokens: 8,
            totalTokens: 20,
            uncachedInputTokens: 9,
            cacheReadInputTokens: 3,
            cacheWriteInputTokens: 1,
            textOutputTokens: 6,
            reasoningOutputTokens: 2,
            reportingStatus: "complete",
          },
        })
      })
    })

    test("keeps projects and workflow executions isolated", async () => {
      await withStorage(async (storage) => {
        await storage.recordModelCall(
          modelCallInput({
            id: "usage_workflow",
            executionId: workflowExecutionId,
            usage: { inputTokens: 5, outputTokens: 3 },
          })
        )
        await storage.recordModelCall(
          modelCallInput({
            id: "usage_other_project",
            projectId: "other-project",
            executionId: workflowExecutionId,
            usage: { inputTokens: 100, outputTokens: 100 },
          })
        )

        await expect(
          storage.summarizeExecution({ projectId, executionId: workflowExecutionId })
        ).resolves.toEqual({
          modelCallCount: 1,
          usage: {
            inputTokens: 5,
            outputTokens: 3,
            totalTokens: 8,
            reportingStatus: "complete",
          },
        })
        await expect(
          storage.summarizeExecution({ projectId, executionId: agentExecutionId })
        ).resolves.toEqual({
          modelCallCount: 0,
          usage: { reportingStatus: "unavailable" },
        })
        await expect(
          storage.summarizeExecution({
            projectId,
            executionId: "exec_workflow_2",
          })
        ).resolves.toEqual({
          modelCallCount: 0,
          usage: { reportingStatus: "unavailable" },
        })
      })
    })

    test("summarizes multiple executions in input order with one zero-call entry per miss", async () => {
      await withStorage(async (storage) => {
        await expect(storage.summarizeExecutions({ projectId, executionIds: [] })).resolves.toEqual(
          []
        )

        await storage.recordModelCall(modelCallInput())
        await storage.recordModelCall(
          modelCallInput({
            id: "usage_agent_2",
            executionId: otherAgentExecutionId,
            callId: "call_agent_2",
            responseId: "response_agent_2",
            usage: { inputTokens: 4, outputTokens: 6 },
          })
        )
        await storage.recordModelCall(
          modelCallInput({
            id: "usage_workflow",
            executionId: workflowExecutionId,
            callId: "call_workflow",
            responseId: "response_workflow",
            usage: { inputTokens: 5, outputTokens: 3 },
          })
        )

        await expect(
          storage.summarizeExecutions({
            projectId,
            executionIds: [
              otherAgentExecutionId,
              "missing",
              workflowExecutionId,
              agentExecutionId,
              otherAgentExecutionId,
            ],
          })
        ).resolves.toEqual([
          {
            modelCallCount: 1,
            usage: {
              inputTokens: 4,
              outputTokens: 6,
              totalTokens: 10,
              reportingStatus: "complete",
            },
          },
          { modelCallCount: 0, usage: { reportingStatus: "unavailable" } },
          {
            modelCallCount: 1,
            usage: {
              inputTokens: 5,
              outputTokens: 3,
              totalTokens: 8,
              reportingStatus: "complete",
            },
          },
          {
            modelCallCount: 1,
            usage: {
              inputTokens: 12,
              outputTokens: 8,
              totalTokens: 20,
              uncachedInputTokens: 9,
              cacheReadInputTokens: 3,
              cacheWriteInputTokens: 1,
              textOutputTokens: 6,
              reasoningOutputTokens: 2,
              reportingStatus: "complete",
            },
          },
          {
            modelCallCount: 1,
            usage: {
              inputTokens: 4,
              outputTokens: 6,
              totalTokens: 10,
              reportingStatus: "complete",
            },
          },
        ])
      })
    })

    test("distinguishes no model calls from a call without reported usage", async () => {
      // Regression guard: coerce nullable SQL token columns with `Number(null)` and this becomes a
      // complete zero-token report instead of an unavailable one.
      await withStorage(async (storage) => {
        await expect(
          storage.summarizeExecution({ projectId, executionId: agentExecutionId })
        ).resolves.toEqual({
          modelCallCount: 0,
          usage: { reportingStatus: "unavailable" },
        })

        const result = await storage.recordModelCall(
          modelCallInput({ usage: {}, rawUsage: undefined })
        )

        expect(result.record.usage).toEqual({ reportingStatus: "unavailable" })
        expect(result.record.rawUsage).toBeUndefined()
        await expect(
          storage.summarizeExecution({ projectId, executionId: agentExecutionId })
        ).resolves.toEqual({
          modelCallCount: 1,
          usage: { reportingStatus: "unavailable" },
        })
      })
    })

    test("normalizes offset timestamps to the same UTC instants", async () => {
      // Regression guard: persist a timezone-naive SQL timestamp and these offset-derived instants
      // shift when read under a different database or process timezone.
      await withStorage(async (storage) => {
        const result = await storage.recordModelCall(
          modelCallInput({
            occurredAt: at("2026-06-23T03:04:05.678-07:00"),
            recordedAt: at("2026-06-23T03:04:06.789-07:00"),
          })
        )

        expect(result.record.occurredAt.toISOString()).toBe("2026-06-23T10:04:05.678Z")
        expect(result.record.recordedAt.toISOString()).toBe("2026-06-23T10:04:06.789Z")
      })
    })

    test("keeps incomplete execution totals partial instead of inventing zeroes", async () => {
      await withStorage(async (storage) => {
        await storage.recordModelCall(
          modelCallInput({ usage: { inputTokens: 10, outputTokens: 5 } })
        )
        await storage.recordModelCall(
          modelCallInput({
            id: "usage_2",
            callId: "call_2",
            responseId: "response_2",
            usage: { inputTokens: 0 },
          })
        )

        await expect(
          storage.summarizeExecution({ projectId, executionId: agentExecutionId })
        ).resolves.toEqual({
          modelCallCount: 2,
          usage: {
            inputTokens: 10,
            reportingStatus: "partial",
          },
        })
      })
    })

    test("defensively snapshots inputs and returned records", async () => {
      await withStorage(async (storage) => {
        const requesterGroupIds = ["support"]
        const rawUsage = { nested: { cached: 3 } }
        const occurredAt = at("2026-06-23T10:00:00.000Z")
        const input = modelCallInput({ requesterGroupIds, rawUsage, occurredAt })
        const first = await storage.recordModelCall(input)

        requesterGroupIds.push("mutated-input")
        rawUsage.nested.cached = 999
        occurredAt.setTime(0)

        const returnedGroups = first.record.requesterGroupIds as string[]
        returnedGroups.push("mutated-output")
        const returnedRaw = first.record.rawUsage as { nested: { cached: number } }
        returnedRaw.nested.cached = 888
        first.record.occurredAt.setTime(1)

        const replay = await storage.recordModelCall(modelCallInput())
        expect(replay.record.requesterGroupIds).toEqual(["support"])
        expect(replay.record.rawUsage).toEqual({ nested: { cached: 3 } })
        expect(replay.record.occurredAt.toISOString()).toBe("2026-06-23T10:00:00.000Z")
      })
    })

    test("rejects a reused record id with a different model-call identity", async () => {
      await withStorage(async (storage) => {
        await storage.recordModelCall(modelCallInput())

        const error = storage.recordModelCall(
          modelCallInput({ callId: "call_2", responseId: "response_2" })
        )
        await expect(error).rejects.toBeInstanceOf(AiUsageStorageError)
        await expect(error).rejects.toMatchObject({ code: "duplicate_id" })
        await expect(
          storage.summarizeExecution({ projectId, executionId: agentExecutionId })
        ).resolves.toMatchObject({
          modelCallCount: 1,
          usage: { inputTokens: 12, outputTokens: 8, totalTokens: 20 },
        })
      })
    })

    test("rejects a model call whose durable execution does not exist", async () => {
      await withStorage(async (storage) => {
        const error = storage.recordModelCall(
          modelCallInput({ id: "usage_missing", executionId: "exec_missing" })
        )
        await expect(error).rejects.toBeInstanceOf(AiUsageStorageError)
        await expect(error).rejects.toMatchObject({ code: "missing_execution" })
      })
    })

    test("rejects invalid execution IDs, usage, dates, groups, and raw JSON", async () => {
      await withStorage(async (storage) => {
        const invalidInputs: RecordAiModelCallInput[] = [
          modelCallInput({ attempt: 0 }),
          modelCallInput({ providerId: " " }),
          modelCallInput({ requesterGroupIds: [""] }),
          modelCallInput({ usage: { inputTokens: -1 } }),
          modelCallInput({ occurredAt: new Date(Number.NaN) }),
          modelCallInput({ rawUsage: { invalid: undefined } as never }),
          modelCallInput({ executionId: "" }),
        ]

        for (const input of invalidInputs) {
          await expect(storage.recordModelCall(input)).rejects.toThrow()
        }
        await expect(
          storage.summarizeExecutions({
            projectId,
            executionIds: [""],
          })
        ).rejects.toThrow()
        await expect(
          storage.summarizeExecution({ projectId, executionId: agentExecutionId })
        ).resolves.toEqual({
          modelCallCount: 0,
          usage: { reportingStatus: "unavailable" },
        })
      })
    })
  })
}

/** Seed the immutable execution references used by the provider-neutral AI usage contract. */
export async function seedAiUsageStorageContractExecutions(
  executions: ExecutionStorage
): Promise<void> {
  for (const fixture of [
    { projectId, executionId: agentExecutionId },
    { projectId, executionId: otherAgentExecutionId },
    { projectId, executionId: workflowExecutionId },
    { projectId: "other-project", executionId: workflowExecutionId },
  ]) {
    const existing = await executions.getById({
      projectId: fixture.projectId,
      id: fixture.executionId,
    })
    if (existing) continue
    const primitive = {
      kind: "workflow" as const,
      id: "ai-usage-contract",
      runId: fixture.executionId,
    }
    await executions.create({
      id: fixture.executionId,
      projectId: fixture.projectId,
      executor: { type: "primitive", kind: primitive.kind, runId: primitive.runId },
      source: { type: "event", eventId: `test_event:${fixture.executionId}` },
      correlationId: `test_correlation:${fixture.executionId}`,
      authorizationRef: { type: "trustedPrimitive", primitive },
    })
  }
}
