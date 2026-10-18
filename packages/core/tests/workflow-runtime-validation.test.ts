import { describe, expect, test } from "bun:test"
import {
  defineIntervention,
  defineObjectType,
  defineWorkflow,
  defineWorkflowStep,
  interventionField,
  prop,
  ref,
  stringEnum,
  WorkflowValidationError,
} from "../src"
import {
  snapshotWorkflowActionInput,
  snapshotWorkflowInput,
  snapshotWorkflowInterventionDefaultResponse,
  snapshotWorkflowInterventionInput,
  snapshotWorkflowInterventionResponse,
  snapshotWorkflowStepInput,
  snapshotWorkflowStepOutput,
  validateWorkflowInput,
  validateWorkflowInterventionDefaultResponse,
  validateWorkflowInterventionInput,
  validateWorkflowInterventionResponse,
  validateWorkflowStepInput,
  validateWorkflowStepOutput,
} from "../src/workflows"

const valueTypesById = new Map<string, never>()

const Transaction = defineObjectType({
  id: "Transaction",
  name: "Transaction",
  properties: [prop("id", "string", { required: true, primary: true })],
})

const Invoice = defineObjectType({
  id: "Invoice",
  name: "Invoice",
  properties: [prop("id", "string", { required: true, primary: true })],
})

const workflow = defineWorkflow("reconcile-transaction")
  .input({
    transaction: ref(Transaction),
  })
  .then(
    defineWorkflowStep("find-best-invoice")
      .input({
        transaction: ref(Transaction),
      })
      .output({
        invoice: ref(Invoice),
        confidence: "double",
      })
      .run(() => ({
        invoice: { objectTypeId: "Invoice", primaryId: "invoice:1" },
        confidence: 0.98,
      }))
  )

const timestampStep = defineWorkflowStep("record-review-window")
  .input({
    reviewedAt: "timestamp",
  })
  .output({
    reviewedAt: "timestamp",
  })
  .run(({ input }) => input)

const reviewDraftDocument = defineIntervention("review-draft-document")
  .input({
    invoice: ref(Invoice),
    proposedTotalCents: "integer",
  })
  .response({
    decision: interventionField(stringEnum(["approve", "request_changes", "reject"]), {
      required: true,
    }),
    finalTotalCents: interventionField("integer", { required: true }),
    reviewerNote: interventionField("string", { required: false }),
    reviewedAt: interventionField("timestamp", { required: false }),
  })

describe("workflow runtime validation", () => {
  test("validates workflow input fields with object refs", () => {
    const input = {
      transaction: { objectTypeId: "Transaction", primaryId: "txn_123" },
    }
    const validate = (value: unknown) => () =>
      validateWorkflowInput({ workflow, value, valueTypesById })

    expect(validate(input)()).toBe(input)
    for (const [value, message] of [
      [{}, "Missing required field 'Workflow \"reconcile-transaction\" input.transaction'"],
      [{ ...input, extra: true }, "Unknown field 'Workflow \"reconcile-transaction\" input.extra'"],
      [
        { transaction: { objectTypeId: "Invoice", primaryId: "invoice:1" } },
        'Property Workflow "reconcile-transaction" input.transaction.objectTypeId',
      ],
    ] as const) {
      expect(validate(value)).toThrow(WorkflowValidationError)
      expect(validate(value)).toThrow(message)
    }
  })

  test("validates step input and output contracts, timestamps included", () => {
    const [node] = workflow.nodes
    if (!node || node.type !== "step") {
      throw new Error("Expected workflow step node")
    }
    const reviewedAt = new Date("2026-05-08T10:00:00.000Z")

    const stepInput = validateWorkflowStepInput({
      workflowId: workflow.id,
      step: node.step,
      value: {
        transaction: { objectTypeId: "Transaction", primaryId: "txn_123" },
      },
      valueTypesById,
    })
    const stepOutput = validateWorkflowStepOutput({
      workflowId: workflow.id,
      step: node.step,
      value: {
        invoice: { objectTypeId: "Invoice", primaryId: "invoice:1" },
        confidence: 0.98,
      },
      valueTypesById,
    })
    const timestampInput = validateWorkflowStepInput({
      workflowId: "review-workflow",
      step: timestampStep,
      value: { reviewedAt },
      valueTypesById,
    })

    expect(stepInput.transaction).toEqual({
      objectTypeId: "Transaction",
      primaryId: "txn_123",
    })
    expect(stepOutput.invoice).toEqual({
      objectTypeId: "Invoice",
      primaryId: "invoice:1",
    })
    expect(timestampInput.reviewedAt).toBe(reviewedAt)

    const invalidOutput = () =>
      validateWorkflowStepOutput({
        workflowId: workflow.id,
        step: node.step,
        value: {
          invoice: { objectTypeId: "Transaction", primaryId: "txn_123" },
          confidence: 0.98,
        },
        valueTypesById,
      })
    expect(invalidOutput).toThrow(WorkflowValidationError)
    expect(invalidOutput).toThrow(
      'Workflow "reconcile-transaction" step "find-best-invoice" output.invoice'
    )
  })

  test("validates intervention input, response, and default response contracts", () => {
    const interventionInput = validateWorkflowInterventionInput({
      workflowId: "draft-invoice-proposal",
      intervention: reviewDraftDocument,
      value: {
        invoice: { objectTypeId: "Invoice", primaryId: "invoice:1" },
        proposedTotalCents: 12500,
      },
      valueTypesById,
    })
    const response = (value: unknown) =>
      validateWorkflowInterventionResponse({
        workflowId: "draft-invoice-proposal",
        intervention: reviewDraftDocument,
        value,
        valueTypesById,
      })
    const defaultResponse = (value: unknown) =>
      validateWorkflowInterventionDefaultResponse({
        workflowId: "draft-invoice-proposal",
        intervention: reviewDraftDocument,
        value,
        valueTypesById,
      })

    expect(interventionInput.invoice).toEqual({
      objectTypeId: "Invoice",
      primaryId: "invoice:1",
    })
    expect(response({ decision: "approve", finalTotalCents: 12500 })).toEqual({
      decision: "approve",
      finalTotalCents: 12500,
    })
    expect(defaultResponse({ finalTotalCents: 12500 })).toEqual({ finalTotalCents: 12500 })

    expect(() => response({ decision: "approve" })).toThrow("Missing required field")
    expect(() => response({ decision: "approve", finalTotalCents: 12500, unknown: true })).toThrow(
      "Unknown field"
    )
    expect(() => defaultResponse({ decision: "escalate" })).toThrow(WorkflowValidationError)
    expect(() => defaultResponse({ extra: true })).toThrow("Unknown field")
  })

  test("snapshots workflow IO as compact JSON-safe values, and rejects what is not JSON", () => {
    const reviewedAt = new Date("2026-05-08T10:00:00.000Z")

    const inputSnapshot = snapshotWorkflowInput({
      workflow,
      value: {
        transaction: { objectTypeId: "Transaction", primaryId: "txn_123" },
      },
      valueTypesById,
    })
    const stepInputSnapshot = snapshotWorkflowStepInput({
      workflowId: "review-workflow",
      step: timestampStep,
      value: { reviewedAt },
      valueTypesById,
    })
    const stepOutputSnapshot = snapshotWorkflowStepOutput({
      workflowId: "review-workflow",
      step: timestampStep,
      value: { reviewedAt },
      valueTypesById,
    })
    const actionInputSnapshot = snapshotWorkflowActionInput({
      subject: { kind: "object", objectTypeId: "Transaction", primaryId: "txn_123" },
      params: {
        reviewedAt,
        invoice: { objectTypeId: "Invoice", primaryId: "invoice:1" },
      },
    })
    const interventionInputSnapshot = snapshotWorkflowInterventionInput({
      workflowId: "draft-invoice-proposal",
      intervention: reviewDraftDocument,
      value: {
        invoice: { objectTypeId: "Invoice", primaryId: "invoice:1" },
        proposedTotalCents: 12500,
      },
      valueTypesById,
    })
    const interventionResponseSnapshot = snapshotWorkflowInterventionResponse({
      workflowId: "draft-invoice-proposal",
      intervention: reviewDraftDocument,
      value: {
        decision: "approve",
        finalTotalCents: 12500,
        reviewedAt,
      },
      valueTypesById,
    })
    const interventionDefaultSnapshot = snapshotWorkflowInterventionDefaultResponse({
      workflowId: "draft-invoice-proposal",
      intervention: reviewDraftDocument,
      value: {
        decision: "approve",
        reviewedAt,
      },
      valueTypesById,
    })

    expect(inputSnapshot).toEqual({
      transaction: { objectTypeId: "Transaction", primaryId: "txn_123" },
    })
    expect(stepInputSnapshot).toEqual({
      reviewedAt: "2026-05-08T10:00:00.000Z",
    })
    expect(stepOutputSnapshot).toEqual({
      reviewedAt: "2026-05-08T10:00:00.000Z",
    })
    expect(actionInputSnapshot).toEqual({
      subject: { kind: "object", objectTypeId: "Transaction", primaryId: "txn_123" },
      params: {
        reviewedAt: "2026-05-08T10:00:00.000Z",
        invoice: { objectTypeId: "Invoice", primaryId: "invoice:1" },
      },
    })
    expect(interventionInputSnapshot).toEqual({
      invoice: { objectTypeId: "Invoice", primaryId: "invoice:1" },
      proposedTotalCents: 12500,
    })
    expect(interventionResponseSnapshot).toEqual({
      decision: "approve",
      finalTotalCents: 12500,
      reviewedAt: "2026-05-08T10:00:00.000Z",
    })
    expect(interventionDefaultSnapshot).toEqual({
      decision: "approve",
      reviewedAt: "2026-05-08T10:00:00.000Z",
    })

    const nonJson = () =>
      snapshotWorkflowActionInput({
        subject: { kind: "object", objectTypeId: "Transaction", primaryId: "txn_123" },
        params: {
          callback: () => undefined,
        },
      })
    expect(nonJson).toThrow(WorkflowValidationError)
    expect(nonJson).toThrow("Workflow action params.callback cannot be serialized as workflow IO")
  })
})
