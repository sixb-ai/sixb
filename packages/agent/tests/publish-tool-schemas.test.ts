import { expect, test } from "bun:test"
import { anthropicOutputSchema } from "../../../models/anthropic/src/structured-output"
import { foundryOutputSchema } from "../../../models/azure-ai-foundry/src/structured-output"
import { isStrictGatewaySchema } from "../../../models/vercel-ai-gateway/src/structured-output"
import {
  PUBLISH_ARTIFACT_TOOL_SPEC,
  PUBLISH_ARTIFACT_VERSION_TOOL_SPEC,
} from "../src/artifacts/publish-tool"

// Whether the Agent creates or revises is the tool it calls, and every argument of each is required
// and meaningful, so every model adapter sends both schemas strict: no model can leave out or invent
// an argument. Reproduce by making `id` optional, or by adding `minLength` to a property.
test.each([
  PUBLISH_ARTIFACT_TOOL_SPEC,
  PUBLISH_ARTIFACT_VERSION_TOOL_SPEC,
])("$name is strict for every model adapter", (spec) => {
  expect(isStrictGatewaySchema(spec.inputSchema)).toBe(true)
  expect(anthropicOutputSchema(spec.inputSchema)).toBeDefined()
  expect(foundryOutputSchema(spec.inputSchema)).toBeDefined()
})
