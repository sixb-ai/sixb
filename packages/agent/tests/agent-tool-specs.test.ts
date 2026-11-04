import { describe, expect, test } from "bun:test"
import { defineAgentTool } from "@sixb/core"
import { type AgentRunWebPlan, agentToolSpec } from "@sixb/core/internal/agents"
import {
  PUBLISH_ARTIFACT_TOOL_SPEC,
  PUBLISH_ARTIFACT_VERSION_TOOL_SPEC,
} from "../src/artifacts/publish-tool"
import { BASH_OUTPUT_TOOL_SPEC, BASH_STOP_TOOL_SPEC } from "../src/tools/background"
import { BASH_TOOL_SPEC } from "../src/tools/bash"
import { agentModelToolSpecs } from "../src/tools/model-spec"
import { READ_TOOL_SPEC } from "../src/tools/read"
import { VIEW_FILE_TOOL_SPEC } from "../src/tools/view-file"
import { WEB_SEARCH_TOOL_SPEC } from "../src/tools/web-search"

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
      VIEW_FILE_TOOL_SPEC,
      READ_TOOL_SPEC,
      BASH_TOOL_SPEC,
      BASH_OUTPUT_TOOL_SPEC,
      BASH_STOP_TOOL_SPEC,
      PUBLISH_ARTIFACT_TOOL_SPEC,
      PUBLISH_ARTIFACT_VERSION_TOOL_SPEC,
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
      VIEW_FILE_TOOL_SPEC.name,
      READ_TOOL_SPEC.name,
      BASH_TOOL_SPEC.name,
      BASH_OUTPUT_TOOL_SPEC.name,
      BASH_STOP_TOOL_SPEC.name,
      WEB_SEARCH_TOOL_SPEC.name,
    ])
  })
})
