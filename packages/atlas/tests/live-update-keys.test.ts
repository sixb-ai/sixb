import { describe, expect, test } from "bun:test"
import { workflowChangedKeys } from "../src/lib/liveUpdateKeys"

describe("workflowChangedKeys", () => {
  test("invalidates the open workflow agent execution debugger", () => {
    expect(workflowChangedKeys("triage", "run-1")).toContainEqual([
      { _id: "getWorkflowAgentNodeExecution" },
    ])
  })
})
