import { describe, expect, test } from "bun:test"
import { workflowChangedKeys } from "../src/pages/ontology/lib/live-update-keys"

describe("workflowChangedKeys", () => {
  test("invalidates the open workflow agent execution debugger", () => {
    expect(workflowChangedKeys("triage", "run-1")).toContainEqual([
      { _id: "getWorkflowAgentNodeExecution" },
    ])
  })
})
