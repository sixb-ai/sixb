import { describe, expect, test } from "bun:test"
import { col, defineDataset } from "../src/datasets"
import { getDatasetRowValidationFailure } from "../src/datasets/validation"
import { withFailureMessage } from "../src/errors/failure-message"
import {
  captureSixbFailure,
  createSixbError,
  parseSixbFailure,
  serializeSixbFailure,
  toSixbFailure,
} from "../src/errors/internal"
import { ActionRunFailedError } from "../src/objects/action/errors"
import { OntologyValidationError } from "../src/ontology/errors"
import { validateSchemaValue } from "../src/ontology/validation/schema"
import { parseActionRunFailure } from "../src/storage/action-runs/failure"

const AT = new Date("2026-09-22T12:00:00.000Z")
function workflow(error: unknown) {
  return captureSixbFailure(error, {
    allowedCodes: ["workflow.node_failed"],
    defaultCode: "workflow.node_failed",
    at: AT,
  })
}
function actionError(
  failure = parseActionRunFailure(
    toSixbFailure(
      createSixbError("action.phase_failed", "private", {
        cause: Object.assign(new Error("private-provider-body"), { status: 429 }),
        details: { phase: "writeback", actionId: "action", runId: "child" },
      })
    )
  )
) {
  return new ActionRunFailedError({
    actionId: "action",
    runId: "child",
    subject: { kind: "none" },
    error: failure,
    finishedAt: AT.toISOString(),
  })
}
function schemaError(schema: Parameters<typeof validateSchemaValue>[0], value: unknown) {
  try {
    validateSchemaValue(schema, value, "Contact.profile", new Map())
  } catch (error) {
    return error
  }
  throw new Error("Expected validation failure")
}

// Regression proof: restore src/errors/internal.ts from HEAD and run this file. The cross-primitive,
// deeper HTTP and marked schema-message assertions must fail; restore the implementation afterwards.
describe("failure explanations across durable boundaries", () => {
  test.each([
    "action.phase_failed",
    "sync.execution_failed",
    "pipeline.step_failed",
    "projection.execution_failed",
    "workflow.node_failed",
    "agent.execution_failed",
    "webhook.delivery_failed",
  ] as const)("retains a value-free schema diagnostic for %s", (code) => {
    const cause = schemaError("integer", "opaque-secret")
    expect(cause).toBeInstanceOf(OntologyValidationError)
    const failure = toSixbFailure(createSixbError(code, "private", { cause }), { at: AT })
    expect(failure.message).toContain("Property Contact.profile must be an integer.")
    expect(failure.code).toBe(code)
    expect(parseSixbFailure(serializeSixbFailure(failure))).toEqual(failure)
    expect(JSON.stringify(failure)).not.toContain("opaque-secret")
    expect(failure).not.toHaveProperty("stack")
    expect(failure).not.toHaveProperty("cause")
  })

  test("does not expose map keys, unknown fields or enum values", () => {
    const map = schemaError(
      { type: "map", keySchema: "string", valueSchema: "integer" },
      { "opaque-key": "opaque-value" }
    )
    expect(workflow(map).message).toContain("Contact.profile.* must be an integer")
    const object = schemaError({ type: "object", properties: {} }, { "opaque-key": "opaque-value" })
    expect(workflow(object).message).toContain("contains an undeclared field")
    const enumeration = schemaError(
      { type: "enum", valueType: "string", values: ["opaque-enum"] },
      "opaque-value"
    )
    expect(workflow(enumeration).message).toContain("must match a declared enum value")
    for (const error of [map, object, enumeration])
      expect(JSON.stringify(workflow(error))).not.toContain("opaque-")
  })

  test("keeps dataset schema diagnostics but excludes unknown column names and values", () => {
    const dataset = defineDataset("contacts", { schema: [col("id", "string")] })
    expect(workflow(getDatasetRowValidationFailure({}, dataset)).message).toContain(
      "missing required column 'id'"
    )
    const failure = workflow(
      getDatasetRowValidationFailure({ id: "id", "opaque-secret": "opaque-value" }, dataset)
    )
    expect(failure.message).toContain("contains an undeclared column")
    expect(JSON.stringify(failure)).not.toContain("opaque-")
  })

  test("retains child explanation, status and flags, with the parent's identity and policy", () => {
    const child = { ...actionError().error, redacted: true as const, truncated: true as const }
    const failure = captureSixbFailure(actionError(child), {
      allowedCodes: ["workflow.node_failed"],
      defaultCode: "workflow.node_failed",
      details: { workflowId: "parent" },
      at: AT,
    })
    expect(failure).toMatchObject({
      code: "workflow.node_failed",
      httpStatus: 429,
      message:
        "Workflow node execution failed. Action execution failed. Upstream request returned HTTP 429.",
      details: { workflowId: "parent" },
      redacted: true,
      truncated: true,
      retryable: false,
    })
    expect(parseSixbFailure(serializeSixbFailure(failure))).toEqual(failure)
    expect(JSON.stringify(failure)).not.toContain("private")
  })

  test("does not repeat the same boundary summary when an action calls another action", () => {
    const failure = toSixbFailure(
      createSixbError("action.phase_failed", "private", { cause: actionError() })
    )
    expect(failure.message).toBe("Action execution failed. Upstream request returned HTTP 429.")
    expect(failure.httpStatus).toBe(429)
  })

  test("does not stop at an intermediate Sixb code", () => {
    const cause = createSixbError("action.phase_failed", "private", {
      cause: Object.assign(new Error("private"), { statusCode: 503 }),
    })
    expect(workflow(cause)).toMatchObject({
      httpStatus: 503,
      message:
        "Workflow node execution failed. Action execution failed. Upstream request returned HTTP 503.",
    })
  })

  test("does not trust arbitrary messages, forged annotations or invalid child records", () => {
    for (const error of [
      new OntologyValidationError("opaque-secret"),
      Object.assign(new Error("opaque-secret"), {
        publicMessage: "opaque-secret",
        failureMessage: "opaque-secret",
        error: actionError().error,
      }),
      actionError({ ...actionError().error, code: "opaque-secret" } as never),
    ])
      expect(workflow(error).message).toBe("Workflow node execution failed.")
  })

  test("filters marked explanations and bounds the composed message", () => {
    const error = withFailureMessage(
      new Error("private"),
      `password=opaque-secret ${"x".repeat(5000)}`
    )
    const failure = workflow(error)
    expect(failure.redacted).toBe(true)
    expect(failure.truncated).toBe(true)
    expect(JSON.stringify(failure)).not.toContain("opaque-secret")
    expect(Buffer.byteLength(failure.message)).toBeLessThanOrEqual(4096)
    expect(parseSixbFailure(serializeSixbFailure(failure))).toEqual(failure)
  })
})
