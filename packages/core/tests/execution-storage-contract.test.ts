import { describe, expect, test } from "bun:test"
import { type ExecutionRecord, InMemoryStorage } from "@sixb/core"
import { ExecutionStorageError } from "../src/storage/executions"
import {
  executionRecordFromStorageRow,
  executionRecordToStorageRow,
} from "../src/storage/executions/provider"
import { runExecutionStorageContractSuite } from "../src/testing"

runExecutionStorageContractSuite("InMemoryStorage execution ledger", {
  createStorage: () => new InMemoryStorage(),
})

describe("execution SQL mapping", () => {
  test("rejects a parent column that contradicts the durable source", () => {
    const execution: ExecutionRecord = {
      id: "child",
      projectId: "project-1",
      executor: { type: "primitive", kind: "workflow", runId: "run-1" },
      source: { type: "execution", executionId: "parent" },
      correlationId: "correlation-1",
      authorizationRef: {
        type: "trustedPrimitive",
        primitive: { kind: "workflow", id: "workflow-1", runId: "run-1" },
      },
      createdAt: new Date("2026-08-21T12:00:00.000Z"),
    }
    const row = executionRecordToStorageRow(execution)

    let thrown: unknown
    try {
      executionRecordFromStorageRow({ ...row, parentExecutionId: "other-parent" })
    } catch (error) {
      thrown = error
    }

    expect(thrown).toBeInstanceOf(ExecutionStorageError)
    expect(thrown).toMatchObject({ code: "invalid_parent_execution" })
  })
})
