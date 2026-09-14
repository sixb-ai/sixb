import { expect, test } from "bun:test"
import { toSixbFailure } from "../src/errors/internal"
import { ModelProviderError, UnsupportedModelFeatureError } from "../src/models/errors"
import { createWorkflowNodeFailure, unwrapWorkflowNodeFailure } from "../src/workflows/failure"

// Regression proof: omit safeModelFailureDetails from createWorkflowNodeFailure; diagnostics vanish.
test.each([
  {
    error: new UnsupportedModelFeatureError("private schema"),
    source: "adapter",
    reason: "unsupported-feature",
  },
  {
    error: new UnsupportedModelFeatureError("private schema", { reason: "unsupported-model" }),
    source: "adapter",
    reason: "unsupported-model",
  },
  {
    error: new UnsupportedModelFeatureError("private schema", { reason: "unsupported-schema" }),
    source: "adapter",
    reason: "unsupported-schema",
  },
  {
    error: new ModelProviderError("private schema", "gateway", "model", {
      status: 400,
      code: "invalid_json_schema",
    }),
    source: "provider",
    reason: "unsupported-schema",
  },
  {
    error: new ModelProviderError("private schema", "gateway", "model", {
      status: 400,
      code: "unsupported_model",
    }),
    source: "provider",
    reason: "unsupported-model",
  },
  {
    error: new ModelProviderError("private schema", "gateway", "model", {
      status: 400,
      code: "private schema",
    }),
    source: "provider",
    reason: "provider-rejection",
  },
])("preserves safe model diagnostics %j", ({ error, source, reason }) => {
  const wrapped = createWorkflowNodeFailure(error, {
    workflowId: "workflow",
    workflowRunId: "run",
    nodeId: "node",
    child: { type: "agent", agentStepId: "agent" },
    failurePhase: "structured-finalizer",
    modelId: "model",
  })
  expect(unwrapWorkflowNodeFailure(wrapped)).toBe(error)
  const durable = toSixbFailure(wrapped, { at: new Date("2026-09-14T00:00:00Z") })
  expect(durable).toMatchObject({
    code: "workflow.node_failed",
    message: "Workflow node execution failed.",
    details: {
      failurePhase: "structured-finalizer",
      modelId: "model",
      modelFailure: { source, reason, message: expect.any(String) },
    },
  })
  expect(JSON.stringify(durable)).not.toContain("private schema")
  expect(durable).not.toHaveProperty("cause")
  expect(durable).not.toHaveProperty("stack")
})
