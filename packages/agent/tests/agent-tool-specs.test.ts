import { describe, expect, test } from "bun:test"
import { defineAgentTool } from "@sixb/core"
import { type AgentRunWebPlan, agentToolSpec } from "@sixb/core/internal/agents"
import type { SandboxNetworkPolicy } from "@sixb/core/sandboxes"
import {
  OPEN_ARTIFACT_TOOL_SPEC,
  PUBLISH_ARTIFACT_TOOL_SPEC,
  UPDATE_ARTIFACT_TOOL_SPEC,
} from "../src/artifacts/publish-tool"
import { BASH_OUTPUT_TOOL_SPEC, BASH_STOP_TOOL_SPEC } from "../src/tools/background"
import { BASH_TOOL_SPEC } from "../src/tools/bash"
import { EDIT_TOOL_SPEC } from "../src/tools/edit"
import { agentModelToolSpecs } from "../src/tools/model-spec"
import { READ_TOOL_SPEC } from "../src/tools/read"
import { WEB_FETCH_TOOL_SPEC } from "../src/tools/web-fetch/tool"
import { WEB_SEARCH_TOOL_SPEC } from "../src/tools/web-search"
import { WRITE_TOOL_SPEC } from "../src/tools/write"

describe("agent model tool specifications", () => {
  test("describes selected and built-in tools in the exact runtime order", () => {
    const lookup = defineAgentTool("lookup")
      .description("Look up one record.")
      .input({ id: "string" })
      .run(async ({ input }) => ({ id: input.id }))

    const specs = agentModelToolSpecs([agentToolSpec(lookup, new Map())])

    expect(specs).toEqual([
      {
        name: "lookup",
        description: "Look up one record.",
        inputSchema: {
          type: "object",
          properties: { id: { type: "string" } },
          required: ["id"],
          additionalProperties: false,
        },
      },
      READ_TOOL_SPEC,
      EDIT_TOOL_SPEC,
      WRITE_TOOL_SPEC,
      BASH_TOOL_SPEC,
      BASH_OUTPUT_TOOL_SPEC,
      BASH_STOP_TOOL_SPEC,
      PUBLISH_ARTIFACT_TOOL_SPEC,
      UPDATE_ARTIFACT_TOOL_SPEC,
      OPEN_ARTIFACT_TOOL_SPEC,
    ])
  })

  // Regression proof: offer the spec whenever plan.web is set; a run without a search model then
  // describes a tool it does not have.
  test("describes web_search only when the plan names a search model", () => {
    const names = (web?: AgentRunWebPlan) =>
      agentModelToolSpecs([], { publishes: false, ...(web ? { web } : {}) }).map(
        (spec) => spec.name
      )

    expect(names()).not.toContain("web_search")
    expect(names({})).not.toContain("web_search")
    expect(names({ search: { provider: "p", modelId: "m" } })).toEqual([
      READ_TOOL_SPEC.name,
      EDIT_TOOL_SPEC.name,
      WRITE_TOOL_SPEC.name,
      BASH_TOOL_SPEC.name,
      BASH_OUTPUT_TOOL_SPEC.name,
      BASH_STOP_TOOL_SPEC.name,
      WEB_SEARCH_TOOL_SPEC.name,
      WEB_FETCH_TOOL_SPEC.name,
    ])
  })

  // Regression proof: return true from fetchesWeb whenever web is set; a sandbox without network
  // then describes a tool that could never reach a page.
  test("describes web_fetch with web tools on, unless the sandbox's network is none", () => {
    const fetches = (web?: AgentRunWebPlan, networkPolicy?: SandboxNetworkPolicy) =>
      agentModelToolSpecs([], {
        publishes: false,
        ...(web ? { web } : {}),
        ...(networkPolicy ? { networkPolicy } : {}),
      }).some((spec) => spec.name === WEB_FETCH_TOOL_SPEC.name)

    expect(fetches()).toBe(false)
    expect(fetches({})).toBe(true)
    expect(fetches({}, { mode: "all" })).toBe(true)
    expect(fetches({}, { mode: "restricted", allow: [] })).toBe(true)
    expect(fetches({}, { mode: "none" })).toBe(false)
  })
})
