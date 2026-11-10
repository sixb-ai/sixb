import { describe, expect, test } from "bun:test"
import { describeDelegationTool, readThreadDelegation } from "../src/agent/delegation/interpret"
import { en } from "../src/agent/i18n/en"
import type { NormalizedTool } from "../src/agent/parts"
import { waitsForChildren, waitsForCommandsOnly } from "../src/agent/waits"

// `wait` and `stop` name background commands by their bg_ id and sub-agents by their key:
// a call for a sub-agent is its row, one for commands alone is theirs.

const call = (toolName: string, input: unknown, output?: unknown): NormalizedTool =>
  ({
    toolName,
    input,
    ...(output === undefined
      ? { state: "input-available" }
      : { state: "output-available", output }),
  }) as NormalizedTool

const spawn = call(
  "spawn_agent",
  { key: "terms", task: "Look into terms." },
  { runId: "agt_run_child_terms", status: "queued" }
)
const rich = (value: unknown) => ({
  kind: "agentToolResult",
  content: [{ type: "text", text: JSON.stringify(value) }],
})

describe("a wait or a stop", () => {
  test("is a sub-agent's when it names one, its commands' when it names only them", () => {
    expect(waitsForChildren(call("wait", { ids: ["terms"] }))).toBe(true)
    expect(waitsForChildren(call("wait", { ids: ["bg_1a2b3c", "terms"] }))).toBe(true)
    expect(waitsForChildren(call("stop", { id: "terms" }))).toBe(true)
    expect(waitsForCommandsOnly(call("wait", { ids: ["bg_1a2b3c"] }))).toBe(true)
    expect(waitsForCommandsOnly(call("stop", { id: "bg_1a2b3c" }))).toBe(true)
    // What earlier threads hold.
    expect(waitsForChildren(call("wait_agent", { runIds: ["agt_run_child_terms"] }))).toBe(true)
    expect(waitsForCommandsOnly(call("bash_output", { id: "bg_1a2b3c" }))).toBe(true)
  })

  // Removal proof: key `waited` by the result's runId alone in readThreadDelegation; a wait by
  // key files its result under the key, and the child's row never reads how it ended.
  test("by key, files what it heard under the child's run", () => {
    const stopped = call(
      "stop",
      { id: "terms" },
      rich({ results: [{ runId: "terms", status: "cancelled" }] })
    )
    const delegation = readThreadDelegation([{ runId: "run_1", tools: [spawn, stopped] }])
    expect(delegation.waited.get("agt_run_child_terms")).toEqual({ status: "cancelled" })
  })

  test("reads as what it does with the sub-agent it names", () => {
    const parts = [{ kind: "tool" as const, tool: spawn }]
    const label = (tool: NormalizedTool) => describeDelegationTool(tool, parts, en)?.title
    expect(label(call("wait", { ids: ["terms"] }))).toBe("Waiting for Terms")
    expect(label(call("wait", { ids: ["terms"] }, rich({ results: [] })))).toBe(
      "Heard back from Terms"
    )
    expect(label(call("stop", { id: "terms" }))).toBe("Stopping Terms")
    expect(label(call("stop", { id: "terms" }, rich({ results: [] })))).toBe("Stopped Terms")
  })
})
