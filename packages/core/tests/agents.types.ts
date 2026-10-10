import {
  type AgentToolDefinition,
  type AgentToolResult,
  type AgentToolRunContext,
  type AgentToolRuntimeFacade,
  defineAgentTool,
  defineConnector,
  defineObjectType,
  type InferAgentToolInput,
  type ObjectReadSet,
  prop,
  stringEnum,
  type WorkflowRuntimeFacade,
} from "../src"

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false
type Expect<T extends true> = T

const knowledgeConnector = defineConnector("knowledge", {
  type: "knowledge",
  connect() {
    return {
      search(query: string) {
        return [query]
      },
    }
  },
})

const searchKnowledge = defineAgentTool("search_knowledge")
  .description("Search project knowledge.")
  .input({
    query: "string",
    limit: "integer",
    requestedAt: "timestamp",
    mode: stringEnum(["quick", "deep"]),
    filters: {
      type: "object",
      properties: {
        active: { schema: "boolean", required: true },
        note: { schema: "string" },
      },
    },
  })
  .run(async (context) => {
    const { input, sixb, logger, run, signal } = context
    const query: string = input.query
    const limit: number = input.limit
    const mode: "quick" | "deep" = input.mode
    const requestedAt: string = input.requestedAt
    const active: boolean = input.filters.active
    const note: string | undefined = input.filters.note
    const knowledge = await sixb.connector(knowledgeConnector)
    const results: string[] = knowledge.search(query)

    logger.info("Searching", { limit, mode, active })
    signal.throwIfAborted()
    const runId: string = run.id
    const workflowId: string | undefined = run.kind === "workflow" ? run.workflowId : undefined
    const stepId: string | undefined = run.kind === "workflow" ? run.stepId : undefined
    // @ts-expect-error Managed service-account identity is not part of the tool context.
    run.agentId
    const threadId: string | undefined = run.kind === "conversation" ? run.threadId : undefined

    // @ts-expect-error tools act as the requester through a narrowed SDK that cannot start workflows
    sixb.workflows
    // @ts-expect-error nor manage schedules, events or the Agent itself
    sixb.agent

    return {
      results,
      note: note ?? null,
      requestedAt,
      runId,
      workflowId: workflowId ?? null,
      stepId: stepId ?? null,
      threadId: threadId ?? null,
    }
  })

type SearchKnowledgeInput = InferAgentToolInput<typeof searchKnowledge>
type _searchKnowledgeInput = Expect<
  Equal<
    SearchKnowledgeInput,
    {
      readonly query: string
      readonly limit: number
      readonly requestedAt: string
      readonly mode: "quick" | "deep"
      readonly filters: { readonly active: boolean; readonly note?: string }
    }
  >
>

const definition: AgentToolDefinition = searchKnowledge

// @ts-expect-error builder stages require a description before an input
defineAgentTool("missing_description").input({})

const missingInputBuilder = defineAgentTool("missing_input").description("Missing input.")
// @ts-expect-error builder stages require an input before a handler
missingInputBuilder.run(() => null)

defineAgentTool("invalid_output")
  .description("Return an invalid output.")
  .input({})
  // @ts-expect-error tool results must be JSON-compatible
  .run(() => ({ createdAt: new Date() }))

defineAgentTool("strict_handler_input")
  .description("Require exactly the declared input.")
  .input({ query: "string" })
  // @ts-expect-error handlers cannot require fields absent from the declared schema
  .run((context: AgentToolRunContext<{ readonly query: string; readonly secret: string }>) => ({
    query: context.input.query,
  }))

defineAgentTool("readonly_handler_input")
  .description("Keep model-provided input immutable.")
  .input({ query: "string" })
  .run(({ input }) => {
    // @ts-expect-error tool inputs are immutable snapshots
    input.query = "changed"
    return null
  })

const readonlyResults: readonly string[] = ["sixb"]
defineAgentTool("readonly_output")
  .description("Accept readonly JSON-compatible output.")
  .input({})
  .run(() => ({ results: readonlyResults }))

defineAgentTool("create_image")
  .description("Create an image artifact.")
  .input({ prompt: "string" })
  .run(async ({ artifacts, toolCallId }) => {
    const { fileRef } = await artifacts.put({
      body: new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
      fileName: "image.png",
      mediaType: "image/png",
    })
    const callId: string = toolCallId
    const result: AgentToolResult = {
      kind: "agentToolResult",
      content: [
        { type: "text", text: `Created an image for ${callId}.` },
        { type: "file", fileRef },
      ],
    }
    return result
  })

// ── Reading project data as the requester ─────────────────────────────────

const Project = defineObjectType({
  id: "project",
  name: "Project",
  properties: [
    prop("id", "string", { required: true, primary: true }),
    prop("name", "string", { required: true, query: { searchable: true, filterable: true } }),
    prop("budget", "double"),
  ],
})

defineAgentTool("find_project")
  .description("Find a project by name.")
  .input({ name: "string" })
  .run(async ({ input, sixb }) => {
    const byQuery = await sixb
      .objects(Project)
      .query()
      .where((project) => project.p.name.eq(input.name))
      .first()
    const byId = await sixb.objects(Project).get("project-1")
    const name: string | undefined = byQuery?.properties.name
    const budget: number | undefined = byId?.properties.budget
    return { name: name ?? null, budget: budget ?? null }
  })

// A tool reads objects like a workflow step, and changes them only through actions.
declare const tool: AgentToolRuntimeFacade
declare const step: WorkflowRuntimeFacade
type _toolObjectsAreReads = Expect<
  Equal<ReturnType<typeof tool.objects<typeof Project>>, ObjectReadSet<typeof Project>>
>
type _sameQueries = Expect<
  Equal<
    ReturnType<ReturnType<typeof tool.objects<typeof Project>>["query"]>,
    ReturnType<ReturnType<typeof step.objects<typeof Project>>["query"]>
  >
>
// @ts-expect-error tools cannot write objects directly
tool.objects(Project).upsert({ properties: { id: "project-1", name: "Alpha" } })
// @ts-expect-error nor delete them or edit their links
tool.objects(Project).byId("project-1").delete()
declare const dataset: Parameters<typeof tool.datasets.readRows>[0]
// @ts-expect-error datasets are read only
tool.datasets.ingest(dataset, { changes: [] })
// @ts-expect-error files a tool produces go through its artifacts
tool.blobs

void definition
