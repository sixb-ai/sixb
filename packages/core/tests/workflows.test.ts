import { describe, expect, test } from "bun:test"
import {
  actionParam,
  defineAction,
  defineIntervention,
  defineObjectType,
  defineSchedule,
  defineWorkflow,
  defineWorkflowStep,
  interventionField,
  isInterventionDefinition,
  isStepDefinition,
  isWorkflowDefinition,
  Pario,
  prop,
  RuntimeError,
  ref,
  stringEnum,
  validateWorkflowDefinition,
  type WorkflowDefinition,
  WorkflowDefinitionError,
} from "../src"
import { createTestRuntimeDeps } from "./test-runtime-deps"

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

type RuntimeWorkflowNode = {
  readonly type: string
  readonly id: string
  readonly key: string
  readonly mapper?: unknown
}

type RuntimeWorkflowDefinition = {
  readonly kind: "workflow"
  readonly id: string
  readonly triggers: readonly unknown[]
  readonly nodes: readonly RuntimeWorkflowNode[]
  then(...args: unknown[]): RuntimeWorkflowDefinition
}

type RuntimeWorkflowDraft = {
  when(schedule: unknown): RuntimeWorkflowDraft
  then(...args: unknown[]): RuntimeWorkflowDefinition
}

type RuntimeWorkflowBuilder = {
  input(input: Record<string, unknown>): RuntimeWorkflowDraft
}

const runtimeDefineWorkflowStep = defineWorkflowStep as unknown as (id: string) => unknown
const runtimeDefineWorkflow = defineWorkflow as unknown as (id: string) => RuntimeWorkflowBuilder

const findBestInvoice = defineWorkflowStep("find-best-invoice")
  .input({
    transaction: ref(Transaction),
  })
  .output({
    transaction: ref(Transaction),
    invoice: ref(Invoice),
    confidence: "double",
  })
  .run(async ({ input }) => ({
    transaction: input.transaction,
    invoice: { objectTypeId: "Invoice", primaryId: "invoice:1" },
    confidence: 0.98,
  }))

const reviewInvoiceMatch = defineWorkflowStep("review-invoice-match")
  .input({
    transaction: ref(Transaction),
    invoice: ref(Invoice),
    confidence: "double",
  })
  .output({
    invoice: ref(Invoice),
  })
  .run(({ input }) => ({ invoice: input.invoice }))

const attachInvoice = defineAction("attach-invoice")
  .target(Transaction)
  .params({
    invoice: actionParam(ref(Invoice), { required: true }),
  })
  .run(async () => {})

const approveInvoiceMatch = defineIntervention("approve-invoice-match", {
  description: "Approve the proposed invoice match before attaching it.",
})
  .input({
    transaction: ref(Transaction),
    invoice: ref(Invoice),
    confidence: "double",
  })
  .response({
    decision: interventionField(stringEnum(["approve", "reject"]), { required: true }),
    invoice: ref(Invoice),
    reviewerNote: interventionField("string", { required: false }),
  })

describe("defineWorkflowStep", () => {
  test("builds an inert step definition", () => {
    expect(findBestInvoice.kind).toBe("step")
    expect(findBestInvoice.id).toBe("find-best-invoice")
    expect(findBestInvoice.input).toEqual({
      transaction: { type: "objectRef", objectTypeId: "Transaction" },
    })
    expect(findBestInvoice.output).toEqual({
      transaction: { type: "objectRef", objectTypeId: "Transaction" },
      invoice: { type: "objectRef", objectTypeId: "Invoice" },
      confidence: "double",
    })
    expect(typeof findBestInvoice.handler).toBe("function")
    expect(isStepDefinition(findBestInvoice)).toBe(true)
  })

  test("rejects empty step ids", () => {
    expect(() => runtimeDefineWorkflowStep("")).toThrow(WorkflowDefinitionError)
    expect(() => runtimeDefineWorkflowStep("")).toThrow("Step id must not be empty")
  })
})

describe("defineIntervention", () => {
  test("builds an inert intervention definition", () => {
    expect(approveInvoiceMatch.kind).toBe("intervention")
    expect(approveInvoiceMatch.id).toBe("approve-invoice-match")
    expect(approveInvoiceMatch.description).toBe(
      "Approve the proposed invoice match before attaching it."
    )
    expect(approveInvoiceMatch.input).toEqual({
      transaction: { type: "objectRef", objectTypeId: "Transaction" },
      invoice: { type: "objectRef", objectTypeId: "Invoice" },
      confidence: "double",
    })
    expect(approveInvoiceMatch.response).toEqual({
      decision: {
        schema: { type: "enum", valueType: "string", values: ["approve", "reject"] },
        required: true,
      },
      invoice: { type: "objectRef", objectTypeId: "Invoice" },
      reviewerNote: { schema: "string", required: false },
    })
    expect(isInterventionDefinition(approveInvoiceMatch)).toBe(true)
  })

  test("supports optional default response values", async () => {
    const intervention = defineIntervention("review-with-defaults")
      .input({
        invoice: ref(Invoice),
        proposedDecision: stringEnum(["approve", "reject"]),
      })
      .response({
        decision: stringEnum(["approve", "reject"]),
        note: interventionField("string", { required: false }),
      })
      .defaults(({ input }) => ({ decision: input.proposedDecision }))

    await expect(
      Promise.resolve(
        intervention.defaults?.({
          input: {
            invoice: { objectTypeId: "Invoice", primaryId: "invoice:1" },
            proposedDecision: "approve",
          },
          workflowInput: {},
          steps: {},
        })
      )
    ).resolves.toEqual({ decision: "approve" })
  })

  test("uses an empty default response when .defaults(...) is not called", async () => {
    await expect(
      Promise.resolve(
        approveInvoiceMatch.defaults?.({
          input: {
            transaction: { objectTypeId: "Transaction", primaryId: "transaction:1" },
            invoice: { objectTypeId: "Invoice", primaryId: "invoice:1" },
            confidence: 0.98,
          },
          workflowInput: {},
          steps: {},
        })
      )
    ).resolves.toEqual({})
  })

  test("rejects empty intervention ids", () => {
    const runtimeDefineIntervention = defineIntervention as unknown as (id: string) => unknown

    expect(() => runtimeDefineIntervention("")).toThrow(WorkflowDefinitionError)
    expect(() => runtimeDefineIntervention("")).toThrow("Intervention id must not be empty")
  })
})

describe("defineWorkflow", () => {
  test("rejects empty workflow ids", () => {
    expect(() => runtimeDefineWorkflow("")).toThrow(WorkflowDefinitionError)
    expect(() => runtimeDefineWorkflow("")).toThrow("Workflow id must not be empty")
  })

  test("attaches schedule triggers through .when()", () => {
    const daily = defineSchedule("daily-reconciliation").cron("0 6 * * *")
    const workflow = runtimeDefineWorkflow("reconcile-transaction")
      .input({
        transaction: ref(Transaction),
      })
      .when(daily)
      .then(findBestInvoice)

    expect(workflow.kind).toBe("workflow")
    expect(workflow.id).toBe("reconcile-transaction")
    expect(workflow.triggers).toEqual([{ type: "schedule", scheduleId: "daily-reconciliation" }])
    expect(workflow.nodes).toHaveLength(1)
    expect(isWorkflowDefinition(workflow)).toBe(true)
  })

  test("stores empty triggers when .when() is not called", () => {
    const workflow = runtimeDefineWorkflow("manual-later")
      .input({
        transaction: ref(Transaction),
      })
      .then(findBestInvoice)

    expect(workflow.triggers).toEqual([])
  })

  test("stores step and action nodes in linear order", () => {
    const workflow = runtimeDefineWorkflow("reconcile-transaction")
      .input({
        transaction: ref(Transaction),
      })
      .then(findBestInvoice)
      .then(reviewInvoiceMatch, () => ({
        transaction: { objectTypeId: "Transaction", primaryId: "transaction:1" },
        invoice: { objectTypeId: "Invoice", primaryId: "invoice:1" },
        confidence: 0.98,
      }))
      .then(attachInvoice, () => ({
        target: { objectTypeId: "Transaction", primaryId: "transaction:1" },
        params: {
          invoice: { objectTypeId: "Invoice", primaryId: "invoice:1" },
        },
      }))

    expect(workflow.nodes).toHaveLength(3)
    expect(workflow.nodes.map((node) => node.type)).toEqual(["step", "step", "action"])
    expect(workflow.nodes.map((node) => node.id)).toEqual([
      "find-best-invoice",
      "review-invoice-match",
      "attach-invoice",
    ])
    expect(workflow.nodes.map((node) => node.key)).toEqual([
      "findBestInvoice",
      "reviewInvoiceMatch",
      "attachInvoice",
    ])
    expect(workflow.nodes[0]).not.toHaveProperty("mapper")
    expect(typeof workflow.nodes[1].mapper).toBe("function")
    expect(typeof workflow.nodes[2].mapper).toBe("function")
  })

  test("stores intervention nodes in linear order", () => {
    const workflow = runtimeDefineWorkflow("review-then-attach")
      .input({
        transaction: ref(Transaction),
      })
      .then(findBestInvoice)
      .then(approveInvoiceMatch)
      .then(attachInvoice, () => ({
        target: { objectTypeId: "Transaction", primaryId: "transaction:1" },
        params: {
          invoice: { objectTypeId: "Invoice", primaryId: "invoice:1" },
        },
      }))

    expect(workflow.nodes).toHaveLength(3)
    expect(workflow.nodes.map((node) => node.type)).toEqual(["step", "intervention", "action"])
    expect(workflow.nodes.map((node) => node.id)).toEqual([
      "find-best-invoice",
      "approve-invoice-match",
      "attach-invoice",
    ])
    expect(workflow.nodes.map((node) => node.key)).toEqual([
      "findBestInvoice",
      "approveInvoiceMatch",
      "attachInvoice",
    ])
    expect(workflow.nodes[1]).toMatchObject({
      type: "intervention",
      intervention: approveInvoiceMatch,
    })
  })

  test("rejects duplicate node ids", () => {
    expect(() => {
      runtimeDefineWorkflow("duplicate-node-id")
        .input({
          transaction: ref(Transaction),
        })
        .then(findBestInvoice)
        .then(findBestInvoice, () => ({
          transaction: { objectTypeId: "Transaction", primaryId: "transaction:1" },
        }))
    }).toThrow(WorkflowDefinitionError)
    expect(() => {
      runtimeDefineWorkflow("duplicate-node-id")
        .input({
          transaction: ref(Transaction),
        })
        .then(findBestInvoice)
        .then(findBestInvoice, () => ({
          transaction: { objectTypeId: "Transaction", primaryId: "transaction:1" },
        }))
    }).toThrow('Duplicate workflow node id "find-best-invoice"')

    expect(() => {
      runtimeDefineWorkflow("duplicate-intervention-node-id")
        .input({
          transaction: ref(Transaction),
        })
        .then(findBestInvoice)
        .then(approveInvoiceMatch)
        .then(approveInvoiceMatch, () => ({
          transaction: { objectTypeId: "Transaction", primaryId: "transaction:1" },
          invoice: { objectTypeId: "Invoice", primaryId: "invoice:1" },
          confidence: 0.98,
        }))
    }).toThrow('Duplicate workflow node id "approve-invoice-match"')
  })

  test("rejects duplicate derived node keys", () => {
    const findBestInvoiceAlt = defineWorkflowStep("find_best_invoice")
      .input({
        transaction: ref(Transaction),
        invoice: ref(Invoice),
        confidence: "double",
      })
      .output({
        invoice: ref(Invoice),
      })
      .run(({ input }) => ({ invoice: input.invoice }))

    expect(() => {
      runtimeDefineWorkflow("duplicate-node-key")
        .input({
          transaction: ref(Transaction),
        })
        .then(findBestInvoice)
        .then(findBestInvoiceAlt, () => ({
          transaction: { objectTypeId: "Transaction", primaryId: "transaction:1" },
          invoice: { objectTypeId: "Invoice", primaryId: "invoice:1" },
          confidence: 0.98,
        }))
    }).toThrow(WorkflowDefinitionError)
    expect(() => {
      runtimeDefineWorkflow("duplicate-node-key")
        .input({
          transaction: ref(Transaction),
        })
        .then(findBestInvoice)
        .then(findBestInvoiceAlt, () => ({
          transaction: { objectTypeId: "Transaction", primaryId: "transaction:1" },
          invoice: { objectTypeId: "Invoice", primaryId: "invoice:1" },
          confidence: 0.98,
        }))
    }).toThrow('Duplicate workflow node key "findBestInvoice"')
  })

  test("rejects invalid runtime .then(...) overloads", () => {
    const draft = runtimeDefineWorkflow("invalid-overload").input({
      transaction: ref(Transaction),
    })
    const then = draft.then

    expect(() => then(attachInvoice)).toThrow(WorkflowDefinitionError)
    expect(() => then(attachInvoice)).toThrow('action node "attach-invoice" requires a mapper')
    expect(() => then(findBestInvoice, "alias")).toThrow(WorkflowDefinitionError)
    expect(() => then(findBestInvoice, () => ({}), "alias")).toThrow(WorkflowDefinitionError)
    expect(() => then(approveInvoiceMatch, "alias")).toThrow(WorkflowDefinitionError)
  })
})

describe("validateWorkflowDefinition", () => {
  test("rejects workflow-shaped objects with no nodes", () => {
    const workflow = {
      kind: "workflow",
      id: "empty",
      input: {},
      triggers: [],
      nodes: [],
      // biome-ignore lint/suspicious/noThenProperty: This validates workflow-shaped definitions.
      then: () => workflow,
    }

    expect(isWorkflowDefinition(workflow)).toBe(true)
    expect(() => validateWorkflowDefinition(workflow)).toThrow(WorkflowDefinitionError)
    expect(() => validateWorkflowDefinition(workflow)).toThrow(
      'Workflow "empty" must contain at least one node'
    )
  })
})

describe("Pario workflow registration", () => {
  test("exposes registered workflow definitions and lookup by id", () => {
    const daily = defineSchedule("daily-reconciliation").cron("0 6 * * *")
    const workflow = defineWorkflow("reconcile-transaction")
      .input({
        transaction: ref(Transaction),
      })
      .when(daily)
      .then(findBestInvoice)
      .then(attachInvoice, ({ input, steps }) => ({
        target: input.transaction,
        params: {
          invoice: steps.findBestInvoice.invoice,
        },
      }))

    const pario = new Pario({
      ontology: [Transaction, Invoice],
      actions: [attachInvoice],
      schedules: [daily],
      workflows: [workflow],
      ...createTestRuntimeDeps(),
    })

    expect(pario.workflows.list()).toEqual([workflow])
    expect(pario.workflows.getById("reconcile-transaction")).toBe(workflow)
    expect(pario.workflows.getById("missing-workflow")).toBeNull()
  })

  test("accepts workflows with intervention nodes during startup validation", () => {
    const workflow = defineWorkflow("review-match")
      .input({
        transaction: ref(Transaction),
      })
      .then(findBestInvoice)
      .then(approveInvoiceMatch)

    const pario = new Pario({
      ontology: [Transaction, Invoice],
      workflows: [workflow],
      ...createTestRuntimeDeps(),
    })

    expect(pario.workflows.getById("review-match")).toBe(workflow)
  })

  test("rejects duplicate workflow ids", () => {
    const first: WorkflowDefinition = defineWorkflow("duplicate-workflow")
      .input({
        transaction: ref(Transaction),
      })
      .then(findBestInvoice)
    const second: WorkflowDefinition = defineWorkflow("duplicate-workflow")
      .input({
        transaction: ref(Transaction),
      })
      .then(findBestInvoice)
    const workflows: readonly WorkflowDefinition[] = [first, second]

    expect(() => {
      new Pario({
        ontology: [Transaction, Invoice],
        workflows,
        ...createTestRuntimeDeps(),
      })
    }).toThrow(RuntimeError)
    expect(() => {
      new Pario({
        ontology: [Transaction, Invoice],
        workflows,
        ...createTestRuntimeDeps(),
      })
    }).toThrow("Duplicate workflow id: duplicate-workflow")
  })

  test("rejects workflows with no nodes during startup validation", () => {
    const workflow = {
      kind: "workflow",
      id: "empty",
      input: {},
      triggers: [],
      nodes: [],
    } satisfies WorkflowDefinition

    expect(() => {
      new Pario({
        ontology: [Transaction],
        workflows: [workflow],
        ...createTestRuntimeDeps(),
      })
    }).toThrow(WorkflowDefinitionError)
    expect(() => {
      new Pario({
        ontology: [Transaction],
        workflows: [workflow],
        ...createTestRuntimeDeps(),
      })
    }).toThrow('Workflow "empty" must contain at least one node')
  })

  test("rejects workflows referencing unknown schedules", () => {
    const missing = defineSchedule("missing-schedule").cron("0 6 * * *")
    const workflow = defineWorkflow("unknown-schedule")
      .input({
        transaction: ref(Transaction),
      })
      .when(missing)
      .then(findBestInvoice)

    expect(() => {
      new Pario({
        ontology: [Transaction, Invoice],
        workflows: [workflow],
        ...createTestRuntimeDeps(),
      })
    }).toThrow(WorkflowDefinitionError)
    expect(() => {
      new Pario({
        ontology: [Transaction, Invoice],
        workflows: [workflow],
        ...createTestRuntimeDeps(),
      })
    }).toThrow('Workflow "unknown-schedule" references unknown schedule "missing-schedule"')
  })

  test("rejects workflows referencing unknown actions", () => {
    const workflow = defineWorkflow("unknown-action")
      .input({
        transaction: ref(Transaction),
      })
      .then(findBestInvoice)
      .then(attachInvoice, ({ input, steps }) => ({
        target: input.transaction,
        params: {
          invoice: steps.findBestInvoice.invoice,
        },
      }))

    expect(() => {
      new Pario({
        ontology: [Transaction, Invoice],
        workflows: [workflow],
        ...createTestRuntimeDeps(),
      })
    }).toThrow(WorkflowDefinitionError)
    expect(() => {
      new Pario({
        ontology: [Transaction, Invoice],
        workflows: [workflow],
        ...createTestRuntimeDeps(),
      })
    }).toThrow('Workflow "unknown-action" references unknown action "attach-invoice"')
  })
})
