import { describe, expect, test } from "bun:test"
import {
  defineAction,
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
  param,
  prop,
  RuntimeError,
  ref,
  type SandboxConfig,
  type SandboxFactory,
  SixbHost,
  stringEnum,
  valueTypeRef,
  type WorkflowDefinition,
  WorkflowDefinitionError,
} from "../src"
import type { AgentReasoning } from "../src/agents"
import type { LanguageModel } from "../src/models"
import { schemaFieldsToJsonSchema, schemaRecordToJsonSchema } from "../src/ontology/internal"
import { createTestSixb } from "../src/testing"
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

function testModel(providerId: string, modelId: string): LanguageModel {
  return {
    providerId,
    modelId,
    definition: { kind: "language", providerId, modelId, capabilities: {} },
    async stream() {
      throw new Error("Definition tests do not run inference.")
    },
  }
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
})

describe("defineAgentStep", () => {
  test("builds an inert structured agent step", () => {
    expect(resolveInvoice.kind).toBe("agentStep")
    expect(resolveInvoice.model).toBe(workflowModel)
    expect(resolveInvoice.instructions).toBe("Resolve invoices from transaction evidence.")
    expect(resolveInvoice.groupIds).toEqual([])
    expect(resolveInvoice.toolNames).toEqual([])
    expect(resolveInvoice.skillNames).toEqual([])
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

  test("keeps its maxSteps, and rejects one that is not a positive integer", () => {
    // Proven by removal: drop the maxSteps check from defineAgentStep.
    const step = (maxSteps: number) =>
      defineAgentStep("bounded", { instructions: "Resolve invoices.", maxSteps })
        .input({})
        .output({})
        .prompt(() => "Resolve.")

    expect(step(40).maxSteps).toBe(40)
    for (const maxSteps of [0, 1.5]) {
      expect(() => step(maxSteps)).toThrow(
        'Agent step "bounded" maxSteps must be a positive integer.'
      )
    }
  })
})

describe("agent step sandboxes", () => {
  const source = { type: "git", url: "https://github.com/acme/app.git" } as const
  const authorize = async (): Promise<never> => {
    throw new Error("Definitions do not authorize.")
  }

  // Hand-built factories reach the step checks without the provider's own validation.
  function factory(configuration?: unknown, supportsRequestCredentials = true): SandboxFactory {
    return {
      supportsRequestCredentials,
      create: async () => {
        throw new Error("Definitions do not create sandboxes.")
      },
      ...(configuration === undefined ? {} : { configuration: configuration as SandboxConfig }),
    }
  }

  const invalid: readonly (readonly [issue: string, sandbox: unknown])[] = [
    ["must be a sandbox factory with a create function.", { configuration: { source } }],
    [
      "must use a static recipe: params and resolve are not supported in workflow steps.",
      factory({ params: { branch: param("string") }, resolve: () => ({ source }) }),
    ],
    [
      "must use a static recipe: params and resolve are not supported in workflow steps.",
      factory({ resolve: () => ({ source }) }),
    ],
    [
      "recipe is invalid: Invalid sandbox source URL: expected credential-free HTTPS.",
      factory({ source: { type: "git", url: "https://token@github.com/acme/app.git" } }),
    ],
    // Regression proof: drop the none check from assertAgentStepSandbox; both rejections fail.
    [
      'network mode "none" cannot run an agent: the agent needs the Sixb API. Use { mode: "restricted", allow: [...] } with the origins the project needs; Sixb adds its own.',
      factory({ source, network: { mode: "none" } }),
    ],
    ["auth requires an authorize function.", factory({ source, auth: {} })],
    [
      'is invalid: Sandbox write access needs source auth: add auth to the sandbox factory or use access "read".',
      factory({ source: { ...source, access: "write" } }),
    ],
    [
      "is invalid: Agent sandboxes need a provider that adds request credentials outside the sandbox, so the agent's commands never hold its token: use a provider whose factory sets supportsRequestCredentials, such as @sixb/sandboxes-local or @sixb/sandboxes-vercel.",
      factory({ source }, false),
    ],
  ]

  function stepWith(sandbox: SandboxFactory) {
    return defineAgentStep("fix-incident", {
      model: workflowModel,
      instructions: "Fix the bug.",
      sandbox,
    })
      .input({})
      .output({ summary: "string" })
      .prompt(() => "Fix it.")
  }

  test("keeps a static factory on the step and omits the field without one", () => {
    const sandbox = factory({ source, setup: ["bun install"], auth: { authorize } })

    expect(stepWith(sandbox).sandbox).toBe(sandbox)
    expect("sandbox" in resolveInvoice).toBe(false)
  })

  test("accepts a restricted network that lists only what the project adds", () => {
    const registry = { name: "npm", origin: "https://registry.npmjs.org" }
    const sandbox = factory({ source, network: { mode: "restricted", allow: [registry] } })

    expect(stepWith(sandbox).sandbox).toBe(sandbox)
  })

  test.each(invalid)("defineAgentStep rejects a sandbox that %s", (issue, sandbox) => {
    // Regression proof: drop assertAgentStepSandbox from sandboxFromAgentStepConfig; it is accepted.
    expect(() => stepWith(sandbox as SandboxFactory)).toThrow(
      new WorkflowDefinitionError(`Agent step "fix-incident" sandbox ${issue}`)
    )
  })

  test.each(invalid)("createSixb rejects a hand-built step whose sandbox %s", (issue, sandbox) => {
    // Regression proof: drop the sandbox check from validateAgentNodeDefinition; it is accepted.
    const workflow = defineWorkflow("repair").input({}).then(stepWith(factory()))
    const handBuilt: WorkflowDefinition = {
      ...workflow,
      nodes: workflow.nodes.map((node) =>
        node.type === "agent"
          ? { ...node, agentStep: { ...node.agentStep, sandbox: sandbox as SandboxFactory } }
          : node
      ),
    }

    expect(
      () =>
        new SixbHost({
          ontology: [],
          models: { language: [workflowModel] },
          workflows: [handBuilt],
          ...createTestRuntimeDeps(),
        })
    ).toThrow(`Workflow "repair" agent step "fix-incident" sandbox ${issue}`)
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

  test("computes default responses, and an empty one when .defaults(...) is not called", async () => {
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
    const invoice = { objectTypeId: "Invoice", primaryId: "invoice:1" } as const

    await expect(
      Promise.resolve(
        intervention.defaults?.({
          input: { invoice, proposedDecision: "approve" },
          workflowInput: {},
          steps: {},
        })
      )
    ).resolves.toEqual({ decision: "approve" })
    await expect(
      Promise.resolve(
        approveInvoiceMatch.defaults?.({
          input: {
            transaction: { objectTypeId: "Transaction", primaryId: "transaction:1" },
            invoice,
            confidence: 0.98,
          },
          workflowInput: {},
          steps: {},
        })
      )
    ).resolves.toEqual({})
  })
})

describe("defineWorkflow", () => {
  test.each([
    { name: "step", define: defineWorkflowStep, message: "Step id must not be empty" },
    {
      name: "intervention",
      define: defineIntervention,
      message: "Intervention id must not be empty",
    },
    { name: "workflow", define: defineWorkflow, message: "Workflow id must not be empty" },
  ])("rejects empty $name ids", ({ define, message }) => {
    const defineEmpty = () => (define as unknown as (id: string) => unknown)("")

    expect(defineEmpty).toThrow(WorkflowDefinitionError)
    expect(defineEmpty).toThrow(message)
  })

  test("records .when() schedules as triggers", () => {
    const daily = defineSchedule("daily-reconciliation").cron("0 6 * * *")
    const draft = () =>
      runtimeDefineWorkflow("reconcile-transaction").input({
        transaction: ref(Transaction),
      })

    const scheduled = draft().when(daily).then(findBestInvoice)
    const onEvent = draft()
      .when(highValueTransaction, ({ event }: { event: { object: { primaryId: string } } }) => ({
        transaction: { objectTypeId: "Transaction", primaryId: event.object.primaryId },
      }))
      .then(findBestInvoice)
    const manual = draft().then(findBestInvoice)

    expect(scheduled.kind).toBe("workflow")
    expect(scheduled.id).toBe("reconcile-transaction")
    expect(isWorkflowDefinition(scheduled)).toBe(true)
    expect(scheduled.triggers).toEqual([{ type: "schedule", scheduleId: "daily-reconciliation" }])
    expect(onEvent.triggers).toEqual([
      { type: "schedule", scheduleId: "transaction.high-value", mapper: expect.any(Function) },
    ])
    expect(manual.triggers).toEqual([])
  })

  test("stores each node type in linear order, with its mapper when one is given", () => {
    const workflow = runtimeDefineWorkflow("review-then-attach")
      .input({
        transaction: ref(Transaction),
      })
      .then(findBestInvoice)
      .then(reviewInvoiceMatch, () => ({
        transaction: { objectTypeId: "Transaction", primaryId: "transaction:1" },
        invoice: { objectTypeId: "Invoice", primaryId: "invoice:1" },
        confidence: 0.98,
      }))
      .then(approveInvoiceMatch)
      .then(resolveInvoice)
      .then(attachInvoice, () => ({
        subject: { objectTypeId: "Transaction", primaryId: "transaction:1" },
        params: {
          invoice: { objectTypeId: "Invoice", primaryId: "invoice:1" },
        },
      }))
    const direct = runtimeDefineWorkflow("direct-action")
      .input({
        subject: ref(Transaction),
        invoice: ref(Invoice),
      })
      .then(attachInvoice)

    expect(workflow.nodes.map((node) => [node.type, node.id, node.key])).toEqual([
      ["step", "find-best-invoice", "findBestInvoice"],
      ["step", "review-invoice-match", "reviewInvoiceMatch"],
      ["intervention", "approve-invoice-match", "approveInvoiceMatch"],
      ["agent", "resolve-invoice", "resolveInvoice"],
      ["action", "attach-invoice", "attachInvoice"],
    ])
    expect(workflow.nodes.map((node) => typeof node.mapper)).toEqual([
      "undefined",
      "function",
      "undefined",
      "undefined",
      "function",
    ])
    expect(workflow.nodes[0]).not.toHaveProperty("mapper")
    expect(workflow.nodes[2]).toMatchObject({ intervention: approveInvoiceMatch })
    expect(workflow.nodes[3]).toMatchObject({ agentStep: resolveInvoice })
    expect(direct.nodes).toHaveLength(1)
    expect(direct.nodes[0]).toMatchObject({
      type: "action",
      id: "attach-invoice",
      key: "attachInvoice",
    })
    expect(direct.nodes[0]).not.toHaveProperty("mapper")
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

describe("SixbHost workflow registration", () => {
  const resolveStep = (
    id: string,
    options: Omit<Parameters<typeof defineAgentStep>[1], "instructions">
  ) =>
    defineAgentStep(id, { instructions: "Resolve invoices.", ...options })
      .input({ transaction: ref(Transaction) })
      .output({ invoice: ref(Invoice) })
      .prompt(({ input }) => `Resolve '${input.transaction.primaryId}'.`)
  const withStep = (id: string, step: ReturnType<typeof resolveStep>): WorkflowDefinition =>
    defineWorkflow(id)
      .input({ transaction: ref(Transaction) })
      .then(step)
  const reconcileFirst = (id: string): WorkflowDefinition =>
    defineWorkflow(id)
      .input({ transaction: ref(Transaction) })
      .then(findBestInvoice)

  test("registers workflows whose references resolve, and looks them up by id", () => {
    const lookup = defineAgentTool("lookup-invoice")
      .description("Look up an invoice.")
      .input({ invoiceId: "string" })
      .run(({ input }) => input)
    const finance = defineGroup("finance")
    const reconcile = defineWorkflow("reconcile-transaction")
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
    const workflows: readonly WorkflowDefinition[] = [
      reconcile,
      defineWorkflow("review-match")
        .input({ transaction: ref(Transaction) })
        .then(findBestInvoice)
        .then(approveInvoiceMatch),
      defineWorkflow("agent-resolution")
        .input({ transaction: ref(Transaction) })
        .then(resolveInvoice),
      // Without a model of its own, an agent step uses the project default.
      defineWorkflow("default-model-workflow")
        .input({ transaction: ref(Transaction) })
        .then(resolveStep("default-model", {})),
      defineWorkflow("configured-task-workflow")
        .input({ transaction: ref(Transaction) })
        .then(
          resolveStep("configured-task", {
            model: workflowModel,
            groups: [finance],
            tools: [lookup],
            skills: ["invoice-review"],
          })
        ),
    ]

    const sixb = createTestSixb({
      ontology: [Transaction, Invoice],
      actions: [attachInvoice],
      schedules: [highValueTransaction],
      models: { language: [workflowModel] },
      tools: [lookup],
      groups: [finance],
      agent: { skills: [{ name: "invoice-review", description: "Review invoices.", files: [] }] },
      workflows,
      ...createTestRuntimeDeps(),
    })

    expect(sixb.workflows.list()).toEqual(workflows)
    for (const workflow of workflows) {
      expect(sixb.workflows.getById(workflow.id)).toBe(workflow)
    }
    expect(sixb.workflows.getById("missing-workflow")).toBeNull()
    expect(sixb.schedules.list()).toEqual([highValueTransaction])
    expect(sixb.schedules.getById("transaction.high-value")).toBe(highValueTransaction)
  })

  test("checks an agent step's reasoning against its model's declared capabilities", () => {
    // Proven by removal: drop the reasoning check from validateWorkflowAgentStepRuntimeReferences.
    const budgeted: LanguageModel = {
      ...workflowModel,
      definition: {
        ...workflowModel.definition,
        capabilities: {
          reasoning: { efforts: ["low"], budgetTokens: { min: 1_024, max: 8_192 } },
        },
      },
    }
    const host = (reasoning: AgentReasoning) =>
      new SixbHost({
        ontology: [Transaction, Invoice],
        models: { language: [budgeted] },
        workflows: [
          defineWorkflow("reasoning-workflow")
            .input({ transaction: ref(Transaction) })
            .then(
              defineAgentStep("reasoning-step", { instructions: "Resolve invoices.", reasoning })
                .input({ transaction: ref(Transaction) })
                .output({ invoice: ref(Invoice) })
                .prompt(({ input }) => `Resolve '${input.transaction.primaryId}'.`)
            ),
        ],
        ...createTestRuntimeDeps(),
      })

    expect(() => host({ budgetTokens: 4_096 })).not.toThrow()
    expect(() => host("low")).not.toThrow()
    expect(() => host({ budgetTokens: 16_384 })).toThrow(
      'Workflow "reasoning-workflow" agent step "reasoning-step" cannot use its reasoning with language model "test/workflow-model": reasoning token budget must not exceed 8192.'
    )
    expect(() => host("high")).toThrow(/reasoning effort 'high' is not supported/)
  })

  test("accepts an agent step's own model outside the catalog and checks its reasoning", () => {
    // Proven by removal: reject an explicit step model that 'models.language' does not list.
    const reviewer: LanguageModel = {
      ...testModel("test", "reviewer-model"),
      definition: {
        kind: "language",
        providerId: "test",
        modelId: "reviewer-model",
        capabilities: { reasoning: { efforts: ["low"] } },
      },
    }
    const host = (reasoning?: AgentReasoning) =>
      new SixbHost({
        ontology: [Transaction, Invoice],
        models: { language: [workflowModel] },
        workflows: [
          withStep(
            "second-opinion-workflow",
            resolveStep("second-opinion", {
              model: reviewer,
              ...(reasoning === undefined ? {} : { reasoning }),
            })
          ),
        ],
        ...createTestRuntimeDeps(),
      })

    expect(() => host()).not.toThrow()
    expect(() => host("low")).not.toThrow()
    expect(() => host("high")).toThrow(
      /agent step "second-opinion" cannot use its reasoning with language model "test\/reviewer-model"/
    )
  })

  test("checks an agent step's reasoning against its tier's model", () => {
    // Proven by removal: check the reasoning against the default model whatever the step's tier.
    const reviewer: LanguageModel = {
      ...testModel("test", "reviewer-model"),
      definition: {
        kind: "language",
        providerId: "test",
        modelId: "reviewer-model",
        capabilities: { reasoning: { efforts: ["low"] } },
      },
    }
    const host = (model: "light" | "heavy") =>
      new SixbHost({
        ontology: [Transaction, Invoice],
        models: { language: { standard: workflowModel, heavy: reviewer } },
        workflows: [
          withStep("tier-workflow", resolveStep("tier-step", { model, reasoning: "high" })),
        ],
        ...createTestRuntimeDeps(),
      })

    // A tier left out runs the standard model, which declares no reasoning limits.
    expect(() => host("light")).not.toThrow()
    expect(() => host("heavy")).toThrow(
      /agent step "tier-step" cannot use its reasoning with language model "test\/reviewer-model"/
    )
  })

  test("rejects an agent step model that is neither a model nor a tier", () => {
    // Proven by removal: drop the tier check from defineAgentStep.
    expect(() =>
      defineAgentStep("unknown-tier", {
        instructions: "Resolve invoices.",
        model: "medium" as unknown as "light",
      })
    ).toThrow(
      'Agent step "unknown-tier" has unknown model tier "medium". Use light, standard or heavy, or pass a model.'
    )
  })

  test("checks an agent step's own model like a catalog model", () => {
    // Proven by removal: drop the assertValidLanguageModel call for step models in validation.
    const limited: LanguageModel = {
      ...testModel("test", "limited-model"),
      definition: {
        kind: "language",
        providerId: "test",
        modelId: "limited-model",
        maxOutputTokens: 4_096,
        capabilities: { reasoning: { efforts: ["low"] } },
      },
    }
    const host = (model: LanguageModel) =>
      new SixbHost({
        ontology: [Transaction, Invoice],
        models: { language: [workflowModel] },
        workflows: [withStep("checked-model-workflow", resolveStep("checked-model", { model }))],
        ...createTestRuntimeDeps(),
      })
    const invalid =
      'Workflow "checked-model-workflow" agent step "checked-model" has an invalid language model: '

    expect(() =>
      host({ ...limited, defaultReasoning: "low", maxOutputTokens: 4_096 })
    ).not.toThrow()
    expect(() => host({ ...limited, defaultReasoning: "high" })).toThrow(
      `${invalid}default reasoning 'high' cannot be used: reasoning effort 'high' is not supported`
    )
    expect(() => host({ ...limited, maxOutputTokens: 8_192 })).toThrow(
      `${invalid}'maxOutputTokens' (8192) exceeds the model maximum (4096).`
    )
    expect(() => host({ ...limited, modelId: "renamed-model" })).toThrow(
      `${invalid}definition identity does not match the binding.`
    )
  })

  test("rejects agent-step skills that are not unique names", () => {
    const define = (skills: unknown) =>
      defineAgentStep("bad-skills", {
        instructions: "Resolve invoices.",
        skills: skills as readonly string[],
      })
    expect(() => define("invoice-review")).toThrow("skills must be an array of Agent Skill names")
    expect(() => define([""])).toThrow("skills must contain only non-empty Agent Skill names")
    expect(() => define(["invoice-review", "invoice-review"])).toThrow(
      "skills contains duplicate skill 'invoice-review'"
    )
  })

  test.each<{
    readonly name: string
    readonly options: Partial<ConstructorParameters<typeof SixbHost>[0]>
    readonly error: new (...args: never[]) => Error
    readonly message: string
  }>([
    {
      name: "an agent step without an explicit or project default model",
      options: {
        workflows: [withStep("missing-model-workflow", resolveStep("missing-model", {}))],
      },
      error: WorkflowDefinitionError,
      message:
        "Workflow \"missing-model-workflow\" agent step \"missing-model\" needs a model. Configure 'models.language' or pass 'model' to defineAgentStep().",
    },
    {
      name: "an agent step tier without 'models.language'",
      options: {
        workflows: [
          withStep("missing-tier-workflow", resolveStep("missing-tier", { model: "light" })),
        ],
      },
      error: WorkflowDefinitionError,
      message:
        'Workflow "missing-tier-workflow" agent step "missing-tier" needs a model for tier "light". Configure \'models.language\' or pass a model to defineAgentStep().',
    },
    {
      name: "an agent-step tool outside the project catalog",
      options: {
        workflows: [
          withStep(
            "unknown-tool-workflow",
            resolveStep("unknown-tool", {
              model: workflowModel,
              tools: [
                defineAgentTool("lookup-invoice")
                  .description("Look up an invoice.")
                  .input({ invoiceId: "string" })
                  .run(({ input }) => input),
              ],
            })
          ),
        ],
      },
      error: WorkflowDefinitionError,
      message: 'uses unknown project tool "lookup-invoice"',
    },
    {
      name: "an agent-step skill outside the project skills",
      options: {
        workflows: [
          withStep(
            "unknown-skill-workflow",
            resolveStep("unknown-skill", { model: workflowModel, skills: ["invoice-review"] })
          ),
        ],
      },
      error: WorkflowDefinitionError,
      message: `Workflow "unknown-skill-workflow" agent step "unknown-skill" uses unknown Agent Skill "invoice-review". Add it as 'skills/invoice-review/SKILL.md'.`,
    },
    {
      name: "an agent-step group outside the security catalog",
      options: {
        workflows: [
          withStep(
            "unknown-group-workflow",
            resolveStep("unknown-group", { model: workflowModel, groups: [defineGroup("finance")] })
          ),
        ],
      },
      error: WorkflowDefinitionError,
      message: 'references unknown group "finance"',
    },
    {
      name: "a duplicate workflow id",
      options: {
        workflows: [reconcileFirst("duplicate-workflow"), reconcileFirst("duplicate-workflow")],
      },
      error: RuntimeError,
      message: "Duplicate workflow id: duplicate-workflow",
    },
    {
      name: "no nodes",
      options: {
        workflows: [{ kind: "workflow", id: "empty", input: {}, triggers: [], nodes: [] }],
      },
      error: WorkflowDefinitionError,
      message: 'Workflow "empty" must contain at least one node',
    },
    {
      name: "an unknown schedule",
      options: {
        workflows: [
          defineWorkflow("unknown-event-schedule")
            .input({ transaction: ref(Transaction) })
            .when(highValueTransaction, ({ event }) => ({
              transaction: { objectTypeId: "Transaction", primaryId: event.object.primaryId },
            }))
            .then(findBestInvoice),
        ],
      },
      error: WorkflowDefinitionError,
      message:
        'Workflow "unknown-event-schedule" references unknown schedule "transaction.high-value"',
    },
    {
      name: "an event schedule but input and no mapper",
      options: {
        schedules: [highValueTransaction],
        workflows: [
          runtimeDefineWorkflow("missing-schedule-mapper")
            .input({ transaction: ref(Transaction) })
            .when(highValueTransaction)
            .then(findBestInvoice) as unknown as WorkflowDefinition,
        ],
      },
      error: WorkflowDefinitionError,
      message:
        'Workflow "missing-schedule-mapper" schedule "transaction.high-value" requires a mapper',
    },
    {
      name: "an unknown action",
      options: {
        workflows: [
          defineWorkflow("unknown-action")
            .input({ transaction: ref(Transaction) })
            .then(findBestInvoice)
            .then(attachInvoice, ({ input, steps }) => ({
              subject: input.transaction,
              params: { invoice: steps.findBestInvoice.invoice },
            })),
        ],
      },
      error: WorkflowDefinitionError,
      message: 'Workflow "unknown-action" references unknown action "attach-invoice"',
    },
  ])("rejects a workflow with $name at startup", ({ options, error, message }) => {
    const register = () =>
      new SixbHost({ ontology: [Transaction, Invoice], ...options, ...createTestRuntimeDeps() })

    expect(register).toThrow(error)
    expect(register).toThrow(message)
  })
})
