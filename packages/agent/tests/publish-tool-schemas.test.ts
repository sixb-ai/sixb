import { expect, test } from "bun:test"
import { anthropicOutputSchema } from "../../../models/anthropic/src/structured-output"
import { foundryStrictTool } from "../../../models/azure-ai-foundry/src/request"
import { requiredNullableSchema } from "../../../models/protocols/src/strict-tools"
import { isStrictGatewaySchema } from "../../../models/vercel-ai-gateway/src/structured-output"
import { OPEN_ARTIFACT_TOOL_SPEC, PUBLISH_ARTIFACT_TOOL_SPEC } from "../src/artifacts/publish-tool"

// One tool creates and revises, with `kind` and `id` optional: every model adapter still sends its
// schema strict, rewriting the optional fields where it must. Reproduce by adding `minLength` to a
// property.
test.each([
  PUBLISH_ARTIFACT_TOOL_SPEC,
  OPEN_ARTIFACT_TOOL_SPEC,
])("$name is strict for every model adapter", (spec) => {
  // As the gateway and Azure send a strict tool: every property required, an optional one nullable.
  expect(isStrictGatewaySchema(requiredNullableSchema(spec.inputSchema))).toBe(true)
  expect(anthropicOutputSchema(spec.inputSchema)).toBeDefined()
  expect(foundryStrictTool(spec)).toBeDefined()
})
