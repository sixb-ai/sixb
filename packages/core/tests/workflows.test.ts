import { describe, expect, test } from "bun:test"
import type { LanguageModelV4 } from "@ai-sdk/provider"
import {
  defineAction,
  defineAgent,
  defineAgentStep,
  defineAgentTool,
  defineGroup,
  defineIntervention,
  defineObjectType,
  defineSchedule,
  defineValueType,
  defineWorkflow,
  defineWorkflowStep,
  events,
  interventionField,
  isAgentStepDefinition,
  isInterventionDefinition,
  isStepDefinition,
  isWorkflowDefinition,
  type OntologySource,
  param,
  prop,
  RuntimeError,
  ref,
  SixbHost,
  stringEnum,
  valueTypeRef,
  type WorkflowDefinition,
  WorkflowDefinitionError,
} from "../src"
import { schemaFieldsToJsonSchema, schemaRecordToJsonSchema } from "../src/ontology/internal"
import { createTestSixb } from "../src/testing"
import { validateWorkflowDefinition, workflowAgentStepActorId } from "../src/workflows"
import { createTestRuntimeDeps } from "./test-runtime-deps"

const Transaction = defineObjectType({
  id: "Transaction",
  name: "Transaction",
  properties: [prop("id", "string", { required: true, primary: true }), prop("amount", "double")],
})

const Invoice = defineObjectType({
  id: "Invoice",
  name: "Invoice",
  properties: [prop("id", "string", { required: true, primary: true })],
})

function testModel(provider: string, modelId: string): LanguageModelV4 {
  return {
    specificationVersion: "v4",
    provider,
    modelId,
    supportedUrls: {},
    async doGenerate() {
      throw new Error("Not implemented by the test model.")
    },
    async doStream() {
      throw new Error("Not implemented by the test model.")
    },
  } as LanguageModelV4
}

const workflowModel = testModel("test", "workflow-model")

const resolveInvoice = defineAgentStep("resolve-invoice", {
  model: workflowModel,
  instructions: "Resolve invoices from transaction evidence.",
})
  .input({ transaction: ref(Transaction) })
  .output({ invoice: ref(Invoice), confidence: "double", reason: "string" })
  .prompt(({ input }) => `Resolve transaction '${input.transaction.primaryId}'.`)

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
  when(...args: unknown[]): RuntimeWorkflowDraft
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
  .on(Transaction)
  .params({
    invoice: param(ref(Invoice)),
  })
  .writeback(async () => {})

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

const highValueTransaction = defineSchedule("transaction.high-value")
  .on(events.object(Transaction).updated())
  .where((event) => event.object.p.amount.gt(500))

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

describe("defineAgentStep", () => {
  test("builds an inert structured agent step", () => {
    expect(resolveInvoice.kind).toBe("agentStep")
    expect(resolveInvoice.model).toBe(workflowModel)
    expect(resolveInvoice.instructions).toBe("Resolve invoices from transaction evidence.")
    expect(resolveInvoice.groupIds).toEqual([])
    expect(resolveInvoice.toolNames).toEqual([])
    expect(resolveInvoice.input).toEqual({
      transaction: { type: "objectRef", objectTypeId: "Transaction" },
    })
    expect(resolveInvoice.output).toEqual({
      invoice: { type: "objectRef", objectTypeId: "Invoice" },
      confidence: "double",
      reason: "string",
    })
    expect(
      resolveInvoice.prompt({
        input: { transaction: { objectTypeId: "Transaction", primaryId: "txn_1" } },
      })
    ).toContain("txn_1")
    expect(isAgentStepDefinition(resolveInvoice)).toBe(true)
  })
})

describe("schemaRecordToJsonSchema", () => {
  test("converts workflow output contracts, including refs and reusable value types", () => {
    const MatchEvidence = defineValueType({
      id: "MatchEvidence",
      name: "Match evidence",
      schema: {
        type: "object",
        properties: {
          source: { schema: "string", required: true },
          notes: { schema: { type: "array", items: "string" } },
        },
      },
    })

    expect(
      schemaRecordToJsonSchema({
        shape: {
          project: ref(Invoice),
          evidence: valueTypeRef(MatchEvidence.id),
          scores: { type: "map", keySchema: "string", valueSchema: "double" },
          amount: "decimal",
          attachment: "fileRef",
        },
        valueTypesById: new Map([[MatchEvidence.id, MatchEvidence]]),
      })
    ).toEqual({
      type: "object",
      properties: {
        project: {
          type: "object",
          properties: {
            objectTypeId: { type: "string", const: "Invoice" },
            primaryId: { type: "string" },
          },
          required: ["objectTypeId", "primaryId"],
          additionalProperties: false,
        },
        evidence: {
          type: "object",
          properties: {
            source: { type: "string" },
            notes: { type: "array", items: { type: "string" } },
          },
          required: ["source"],
          additionalProperties: false,
        },
        scores: { type: "object", additionalProperties: { type: "number" } },
        amount: { type: "string", pattern: "^[+-]?\\d+(?:\\.\\d+)?$" },
        attachment: {
          type: "object",
          properties: {
            blobId: { type: "string" },
            digest: { type: "string", pattern: "^sha256:[a-fA-F0-9]{64}$" },
            sizeBytes: { type: "integer", minimum: 0 },
            fileName: { type: "string" },
            mediaType: { type: "string" },
            logicalPath: { type: "string" },
          },
          required: ["blobId", "digest", "sizeBytes"],
          additionalProperties: false,
        },
      },
      required: ["project", "evidence", "scores", "amount", "attachment"],
      additionalProperties: false,
    })
  })

  test("rejects unresolved reusable value types", () => {
    expect(() =>
      schemaRecordToJsonSchema({
        shape: { evidence: valueTypeRef("MissingEvidence") },
        valueTypesById: new Map(),
      })
    ).toThrow("unknown value type 'MissingEvidence'")
  })

  test("projects configured optional and nullable fields without weakening reference shapes", () => {
    expect(
      schemaFieldsToJsonSchema({
        fields: {
          attempt: {
            schema: ref(Invoice),
            required: true,
          },
          note: {
            schema: "string",
          },
          reviewedAt: {
            schema: "timestamp",
            nullable: true,
          },
        },
        valueTypesById: new Map(),
      })
    ).toEqual({
      type: "object",
      properties: {
        attempt: {
          type: "object",
          properties: {
            objectTypeId: { type: "string", const: "Invoice" },
            primaryId: { type: "string" },
          },
          required: ["objectTypeId", "primaryId"],
          additionalProperties: false,
        },
        note: { type: "string" },
        reviewedAt: {
          anyOf: [{ type: "string", format: "date-time" }, { type: "null" }],
        },
      },
      required: ["attempt"],
      additionalProperties: false,
    })
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

  test("attaches event schedules through .when()", () => {
    const workflow = runtimeDefineWorkflow("review-high-value-transaction")
      .input({
        transaction: ref(Transaction),
      })
      .when(highValueTransaction, ({ event }: { event: { object: { primaryId: string } } }) => ({
        transaction: { objectTypeId: "Transaction", primaryId: event.object.primaryId },
      }))
      .then(findBestInvoice)

    expect(workflow.triggers).toHaveLength(1)
    expect(workflow.triggers[0]).toMatchObject({
      type: "schedule",
      scheduleId: "transaction.high-value",
    })
    expect(typeof (workflow.triggers[0] as { mapper?: unknown }).mapper).toBe("function")
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
        subject: { objectTypeId: "Transaction", primaryId: "transaction:1" },
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

  test("stores direct action nodes without a mapper", () => {
    const workflow = runtimeDefineWorkflow("direct-action")
      .input({
        subject: ref(Transaction),
        invoice: ref(Invoice),
      })
      .then(attachInvoice)

    expect(workflow.nodes).toHaveLength(1)
    expect(workflow.nodes[0]).toMatchObject({
      type: "action",
      id: "attach-invoice",
      key: "attachInvoice",
    })
    expect(workflow.nodes[0]).not.toHaveProperty("mapper")
  })

  test("stores intervention nodes in linear order", () => {
    const workflow = runtimeDefineWorkflow("review-then-attach")
      .input({
        transaction: ref(Transaction),
      })
      .then(findBestInvoice)
      .then(approveInvoiceMatch)
      .then(attachInvoice, () => ({
        subject: { objectTypeId: "Transaction", primaryId: "transaction:1" },
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

  test("stores agent nodes as first-class workflow nodes", () => {
    const workflow = defineWorkflow("resolve-with-agent")
      .input({ transaction: ref(Transaction) })
      .then(resolveInvoice)

    expect(workflow.nodes[0]).toMatchObject({
      type: "agent",
      id: "resolve-invoice",
      key: "resolveInvoice",
      agentStep: resolveInvoice,
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

    expect(() => then(attachInvoice, "alias")).toThrow(WorkflowDefinitionError)
    expect(() => then(findBestInvoice, "alias")).toThrow(WorkflowDefinitionError)
    expect(() => then(findBestInvoice, () => ({}), "alias")).toThrow(WorkflowDefinitionError)
    expect(() => then(approveInvoiceMatch, "alias")).toThrow(WorkflowDefinitionError)
  })

  test("rejects invalid runtime .when(...) overloads", () => {
    const draft = runtimeDefineWorkflow("invalid-trigger-overload").input({
      transaction: ref(Transaction),
    })
    const when = draft.when

    expect(() => when(highValueTransaction, "mapper")).toThrow(WorkflowDefinitionError)
    expect(() => when(highValueTransaction, () => ({}), "extra")).toThrow(WorkflowDefinitionError)
    expect(() => when({ kind: "schedule" })).toThrow(WorkflowDefinitionError)
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

describe("SixbHost workflow registration", () => {
  test("exposes registered workflow definitions and lookup by id", () => {
    const workflow = defineWorkflow("reconcile-transaction")
      .input({
        transaction: ref(Transaction),
      })
      .when(highValueTransaction, ({ event }) => ({
        transaction: {
          objectTypeId: "Transaction",
          primaryId: event.object.primaryId,
        },
      }))
      .then(findBestInvoice)
      .then(attachInvoice, ({ input, steps }) => ({
        subject: input.transaction,
        params: {
          invoice: steps.findBestInvoice.invoice,
        },
      }))

    const sixb = createTestSixb({
      ontology: [Transaction, Invoice],
      actions: [attachInvoice],
      schedules: [highValueTransaction],
      workflows: [workflow],
      ...createTestRuntimeDeps(),
    })

    expect(sixb.workflows.list()).toEqual([workflow])
    expect(sixb.workflows.getById("reconcile-transaction")).toBe(workflow)
    expect(sixb.workflows.getById("missing-workflow")).toBeNull()
  })

  test("accepts workflows with intervention nodes during startup validation", () => {
    const workflow = defineWorkflow("review-match")
      .input({
        transaction: ref(Transaction),
      })
      .then(findBestInvoice)
      .then(approveInvoiceMatch)

    const sixb = createTestSixb({
      ontology: [Transaction, Invoice],
      workflows: [workflow],
      ...createTestRuntimeDeps(),
    })

    expect(sixb.workflows.getById("review-match")).toBe(workflow)
  })

  test("registers directly configured workflow agent steps", () => {
    const workflow = defineWorkflow("agent-resolution")
      .input({ transaction: ref(Transaction) })
      .then(resolveInvoice)

    const sixb = createTestSixb({
      ontology: [Transaction, Invoice],
      workflows: [workflow],
      ...createTestRuntimeDeps(),
    })
    expect(sixb.workflows.getById(workflow.id)).toBe(workflow)
  })

  test("uses the project default model when an agent step omits its model", () => {
    const step = defineAgentStep("default-model", {
      instructions: "Resolve invoices.",
    })
      .input({ transaction: ref(Transaction) })
      .output({ invoice: ref(Invoice) })
      .prompt(({ input }) => `Resolve '${input.transaction.primaryId}'.`)
    const workflow: WorkflowDefinition = defineWorkflow("default-model-workflow")
      .input({ transaction: ref(Transaction) })
      .then(step)

    const sixb = createTestSixb({
      ontology: [Transaction, Invoice],
      models: { language: [workflowModel] },
      workflows: [workflow],
      ...createTestRuntimeDeps(),
    })

    expect(sixb.workflows.getById(workflow.id)).toBe(workflow)
  })

  test("rejects an agent step without an explicit or project default model", () => {
    const step = defineAgentStep("missing-model", {
      instructions: "Resolve invoices.",
    })
      .input({ transaction: ref(Transaction) })
      .output({ invoice: ref(Invoice) })
      .prompt(({ input }) => `Resolve '${input.transaction.primaryId}'.`)
    const workflow: WorkflowDefinition = defineWorkflow("missing-model-workflow")
      .input({ transaction: ref(Transaction) })
      .then(step)

    expect(
      () =>
        new SixbHost<readonly OntologySource[]>({
          ontology: [Transaction, Invoice],
          workflows: [workflow],
          ...createTestRuntimeDeps(),
        })
    ).toThrow(/needs a model/)
  })

  test("rejects an explicit agent-step model outside the project catalog", () => {
    const unavailableModel = testModel("test", "unavailable-model")
    const step = defineAgentStep("unknown-model", {
      model: unavailableModel,
      instructions: "Resolve invoices.",
    })
      .input({ transaction: ref(Transaction) })
      .output({ invoice: ref(Invoice) })
      .prompt(({ input }) => `Resolve '${input.transaction.primaryId}'.`)
    const workflow: WorkflowDefinition = defineWorkflow("unknown-model-workflow")
      .input({ transaction: ref(Transaction) })
      .then(step)

    expect(
      () =>
        new SixbHost<readonly OntologySource[]>({
          ontology: [Transaction, Invoice],
          models: { language: [workflowModel] },
          workflows: [workflow],
          ...createTestRuntimeDeps(),
        })
    ).toThrow(/uses unknown language model "test\/unavailable-model"/)
  })

  test("rejects an agent-step tool outside the project catalog", () => {
    const lookup = defineAgentTool("lookup-invoice")
      .description("Look up an invoice.")
      .input({ invoiceId: "string" })
      .run(({ input }) => input)
    const step = defineAgentStep("unknown-tool", {
      model: workflowModel,
      instructions: "Resolve invoices.",
      tools: [lookup],
    })
      .input({ transaction: ref(Transaction) })
      .output({ invoice: ref(Invoice) })
      .prompt(({ input }) => `Resolve '${input.transaction.primaryId}'.`)
    const workflow: WorkflowDefinition = defineWorkflow("unknown-tool-workflow")
      .input({ transaction: ref(Transaction) })
      .then(step)

    expect(
      () =>
        new SixbHost<readonly OntologySource[]>({
          ontology: [Transaction, Invoice],
          workflows: [workflow],
          ...createTestRuntimeDeps(),
        })
    ).toThrow(/uses unknown project tool "lookup-invoice"/)
  })

  test("accepts explicitly selected registered tools and groups", () => {
    const lookup = defineAgentTool("lookup-invoice")
      .description("Look up an invoice.")
      .input({ invoiceId: "string" })
      .run(({ input }) => input)
    const finance = defineGroup("finance")
    const step = defineAgentStep("configured-task", {
      model: workflowModel,
      instructions: "Resolve invoices.",
      groups: [finance],
      tools: [lookup],
    })
      .input({ transaction: ref(Transaction) })
      .output({ invoice: ref(Invoice) })
      .prompt(({ input }) => `Resolve '${input.transaction.primaryId}'.`)
    const workflow: WorkflowDefinition = defineWorkflow("configured-task-workflow")
      .input({ transaction: ref(Transaction) })
      .then(step)

    const sixb = createTestSixb({
      ontology: [Transaction, Invoice],
      tools: [lookup],
      groups: [finance],
      workflows: [workflow],
      ...createTestRuntimeDeps(),
    })

    expect(sixb.workflows.getById(workflow.id)).toBe(workflow)
  })

  test("rejects an agent-step group outside the security catalog", () => {
    const finance = defineGroup("finance")
    const step = defineAgentStep("unknown-group", {
      model: workflowModel,
      instructions: "Resolve invoices.",
      groups: [finance],
    })
      .input({ transaction: ref(Transaction) })
      .output({ invoice: ref(Invoice) })
      .prompt(({ input }) => `Resolve '${input.transaction.primaryId}'.`)
    const workflow: WorkflowDefinition = defineWorkflow("unknown-group-workflow")
      .input({ transaction: ref(Transaction) })
      .then(step)

    expect(
      () =>
        new SixbHost<readonly OntologySource[]>({
          ontology: [Transaction, Invoice],
          workflows: [workflow],
          ...createTestRuntimeDeps(),
        })
    ).toThrow(/references unknown group "finance"/)
  })

  test("rejects a registered agent that collides with a workflow task identity", () => {
    const step = defineAgentStep("review", {
      model: workflowModel,
      instructions: "Review the invoice.",
    })
      .input({ transaction: ref(Transaction) })
      .output({ invoice: ref(Invoice) })
      .prompt(({ input }) => `Review '${input.transaction.primaryId}'.`)
    const workflow: WorkflowDefinition = defineWorkflow("invoice-review")
      .input({ transaction: ref(Transaction) })
      .then(step)
    const actorId = workflowAgentStepActorId(workflow.id, step.id)
    const collidingAgent = defineAgent(actorId, {
      name: "Colliding agent",
      model: workflowModel,
      instructions: "This identity is reserved by the workflow task.",
    })

    expect(
      () =>
        new SixbHost<readonly OntologySource[]>({
          ontology: [Transaction, Invoice],
          agents: [collidingAgent],
          workflows: [workflow],
          ...createTestRuntimeDeps(),
        })
    ).toThrow(/conflicts with registered agent/)
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
      createTestSixb({
        ontology: [Transaction, Invoice],
        workflows,
        ...createTestRuntimeDeps(),
      })
    }).toThrow(RuntimeError)
    expect(() => {
      createTestSixb({
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
      createTestSixb({
        ontology: [Transaction],
        workflows: [workflow],
        ...createTestRuntimeDeps(),
      })
    }).toThrow(WorkflowDefinitionError)
    expect(() => {
      createTestSixb({
        ontology: [Transaction],
        workflows: [workflow],
        ...createTestRuntimeDeps(),
      })
    }).toThrow('Workflow "empty" must contain at least one node')
  })

  test("rejects workflows referencing unknown schedules", () => {
    const missing = defineSchedule("missing-schedule").cron("0 6 * * *")
    const workflow = runtimeDefineWorkflow("unknown-schedule")
      .input({
        transaction: ref(Transaction),
      })
      .when(missing)
      .then(findBestInvoice)

    expect(() => {
      createTestSixb({
        ontology: [Transaction, Invoice],
        workflows: [workflow as unknown as WorkflowDefinition],
        ...createTestRuntimeDeps(),
      })
    }).toThrow(WorkflowDefinitionError)
    expect(() => {
      createTestSixb({
        ontology: [Transaction, Invoice],
        workflows: [workflow as unknown as WorkflowDefinition],
        ...createTestRuntimeDeps(),
      })
    }).toThrow('Workflow "unknown-schedule" references unknown schedule "missing-schedule"')
  })

  test("accepts workflows referencing registered event schedules", () => {
    const workflow = defineWorkflow("registered-event-schedule")
      .input({
        transaction: ref(Transaction),
      })
      .when(highValueTransaction, ({ event }) => ({
        transaction: {
          objectTypeId: "Transaction",
          primaryId: event.object.primaryId,
        },
      }))
      .then(findBestInvoice)

    const sixb = createTestSixb({
      ontology: [Transaction, Invoice],
      schedules: [highValueTransaction],
      workflows: [workflow],
      ...createTestRuntimeDeps(),
    })

    expect(sixb.schedules.list()).toEqual([highValueTransaction])
    expect(sixb.schedules.getById("transaction.high-value")).toBe(highValueTransaction)
    expect(sixb.workflows.getById("registered-event-schedule")).toBe(workflow)
  })

  test("rejects workflows referencing unknown event schedules", () => {
    const workflow = defineWorkflow("unknown-event-schedule")
      .input({
        transaction: ref(Transaction),
      })
      .when(highValueTransaction, ({ event }) => ({
        transaction: {
          objectTypeId: "Transaction",
          primaryId: event.object.primaryId,
        },
      }))
      .then(findBestInvoice)

    expect(() => {
      createTestSixb({
        ontology: [Transaction, Invoice],
        workflows: [workflow],
        ...createTestRuntimeDeps(),
      })
    }).toThrow(
      'Workflow "unknown-event-schedule" references unknown schedule "transaction.high-value"'
    )
  })

  test("rejects event-scheduled workflows with input and no mapper at runtime", () => {
    const workflow = runtimeDefineWorkflow("missing-schedule-mapper")
      .input({
        transaction: ref(Transaction),
      })
      .when(highValueTransaction)
      .then(findBestInvoice)

    expect(() => {
      createTestSixb({
        ontology: [Transaction, Invoice],
        schedules: [highValueTransaction],
        workflows: [workflow as unknown as WorkflowDefinition],
        ...createTestRuntimeDeps(),
      })
    }).toThrow(
      'Workflow "missing-schedule-mapper" schedule "transaction.high-value" requires a mapper'
    )
  })

  test("rejects workflows referencing unknown actions", () => {
    const workflow = defineWorkflow("unknown-action")
      .input({
        transaction: ref(Transaction),
      })
      .then(findBestInvoice)
      .then(attachInvoice, ({ input, steps }) => ({
        subject: input.transaction,
        params: {
          invoice: steps.findBestInvoice.invoice,
        },
      }))

    expect(() => {
      createTestSixb({
        ontology: [Transaction, Invoice],
        workflows: [workflow],
        ...createTestRuntimeDeps(),
      })
    }).toThrow(WorkflowDefinitionError)
    expect(() => {
      createTestSixb({
        ontology: [Transaction, Invoice],
        workflows: [workflow],
        ...createTestRuntimeDeps(),
      })
    }).toThrow('Workflow "unknown-action" references unknown action "attach-invoice"')
  })
})
