import { describe, expect, test } from "bun:test"
import {
  defineObjectType,
  defineWorkflow,
  defineWorkflowStep,
  prop,
  ref,
  snapshotWorkflowActionInput,
  snapshotWorkflowInput,
  snapshotWorkflowStepInput,
  snapshotWorkflowStepOutput,
  validateWorkflowInput,
  validateWorkflowStepInput,
  validateWorkflowStepOutput,
  WorkflowValidationError,
} from "../src"

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

describe("workflow runtime validation", () => {
  test("validates workflow input with object refs", () => {
    const input = {
      transaction: { objectTypeId: "Transaction", primaryId: "txn_123" },
    }

    const validated = validateWorkflowInput({
      workflow,
      value: input,
      valueTypesById,
    })

    expect(validated).toBe(input)
  })

  test("rejects missing, unknown, and invalid workflow input fields", () => {
    expect(() =>
      validateWorkflowInput({
        workflow,
        value: {},
        valueTypesById,
      })
    ).toThrow(WorkflowValidationError)
    expect(() =>
      validateWorkflowInput({
        workflow,
        value: {},
        valueTypesById,
      })
    ).toThrow("Missing required field 'Workflow \"reconcile-transaction\" input.transaction'")

    expect(() =>
      validateWorkflowInput({
        workflow,
        value: {
          transaction: { objectTypeId: "Transaction", primaryId: "txn_123" },
          extra: true,
        },
        valueTypesById,
      })
    ).toThrow(WorkflowValidationError)
    expect(() =>
      validateWorkflowInput({
        workflow,
        value: {
          transaction: { objectTypeId: "Transaction", primaryId: "txn_123" },
          extra: true,
        },
        valueTypesById,
      })
    ).toThrow("Unknown field 'Workflow \"reconcile-transaction\" input.extra'")

    expect(() =>
      validateWorkflowInput({
        workflow,
        value: {
          transaction: { objectTypeId: "Invoice", primaryId: "invoice:1" },
        },
        valueTypesById,
      })
    ).toThrow(WorkflowValidationError)
    expect(() =>
      validateWorkflowInput({
        workflow,
        value: {
          transaction: { objectTypeId: "Invoice", primaryId: "invoice:1" },
        },
        valueTypesById,
      })
    ).toThrow('Property Workflow "reconcile-transaction" input.transaction.objectTypeId')
  })

  test("validates step input and output contracts", () => {
    const [node] = workflow.nodes
    if (!node || node.type !== "step") {
      throw new Error("Expected workflow step node")
    }

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

    expect(stepInput.transaction).toEqual({
      objectTypeId: "Transaction",
      primaryId: "txn_123",
    })
    expect(stepOutput.invoice).toEqual({
      objectTypeId: "Invoice",
      primaryId: "invoice:1",
    })
  })

  test("rejects invalid step output contracts", () => {
    const [node] = workflow.nodes
    if (!node || node.type !== "step") {
      throw new Error("Expected workflow step node")
    }

    expect(() =>
      validateWorkflowStepOutput({
        workflowId: workflow.id,
        step: node.step,
        value: {
          invoice: { objectTypeId: "Transaction", primaryId: "txn_123" },
          confidence: 0.98,
        },
        valueTypesById,
      })
    ).toThrow(WorkflowValidationError)
    expect(() =>
      validateWorkflowStepOutput({
        workflowId: workflow.id,
        step: node.step,
        value: {
          invoice: { objectTypeId: "Transaction", primaryId: "txn_123" },
          confidence: 0.98,
        },
        valueTypesById,
      })
    ).toThrow('Workflow "reconcile-transaction" step "find-best-invoice" output.invoice')
  })

  test("accepts Date values for timestamp contracts", () => {
    const reviewedAt = new Date("2026-05-08T10:00:00.000Z")

    const validated = validateWorkflowStepInput({
      workflowId: "review-workflow",
      step: timestampStep,
      value: {
        reviewedAt,
      },
      valueTypesById,
    })

    expect(validated.reviewedAt).toBe(reviewedAt)
  })

  test("snapshots workflow IO as compact JSON-safe values", () => {
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
      target: { objectTypeId: "Transaction", primaryId: "txn_123" },
      params: {
        reviewedAt,
        invoice: { objectTypeId: "Invoice", primaryId: "invoice:1" },
      },
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
      target: { objectTypeId: "Transaction", primaryId: "txn_123" },
      params: {
        reviewedAt: "2026-05-08T10:00:00.000Z",
        invoice: { objectTypeId: "Invoice", primaryId: "invoice:1" },
      },
    })
  })

  test("rejects non-JSON workflow IO snapshots with path context", () => {
    expect(() =>
      snapshotWorkflowActionInput({
        target: { objectTypeId: "Transaction", primaryId: "txn_123" },
        params: {
          callback: () => undefined,
        },
      })
    ).toThrow(WorkflowValidationError)

    expect(() =>
      snapshotWorkflowActionInput({
        target: { objectTypeId: "Transaction", primaryId: "txn_123" },
        params: {
          callback: () => undefined,
        },
      })
    ).toThrow("Workflow action params.callback cannot be serialized as workflow IO")
  })
})
