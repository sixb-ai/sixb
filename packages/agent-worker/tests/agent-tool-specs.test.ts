import { describe, expect, test } from "bun:test"
import { defineAgentTool } from "@sixb/core"
import { BASH_TOOL_SPEC } from "../src/tools/bash"
import { agentModelToolSpecs } from "../src/tools/model-spec"
import { READ_TOOL_SPEC } from "../src/tools/read"
import { VIEW_FILE_TOOL_SPEC } from "../src/tools/view-file"

describe("agent model tool specifications", () => {
  test("describes selected and built-in tools in the exact runtime order", () => {
    const lookup = defineAgentTool("lookup")
      .description("Look up one record.")
      .input({ id: "string" })
      .run(async ({ input }) => ({ id: input.id }))

    const specs = agentModelToolSpecs({
      definitions: [lookup],
      valueTypesById: new Map(),
    })

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
    ])
  })
})
