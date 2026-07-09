import { describe, expect, test } from "bun:test"
import { getViewModeFromPath } from "../src/components/layout/viewMode"

describe("getViewModeFromPath", () => {
  test("maps generic run routes back to their primitive navigation item", () => {
    expect(getViewModeFromPath("/runs/sync/run-1")).toBe("syncs")
    expect(getViewModeFromPath("/runs/pipeline/run-1")).toBe("pipelines")
    expect(getViewModeFromPath("/runs/workflow/run-1")).toBe("workflows")
    expect(getViewModeFromPath("/runs/action/run-1")).toBe("actions")
  })

  test("keeps the legacy workflow run route mapped to workflows", () => {
    expect(getViewModeFromPath("/runs/run-1")).toBe("workflows")
  })
})
