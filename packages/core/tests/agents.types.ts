import {
  type AgentToolDefinition,
  type AgentToolResult,
  type AgentToolRunContext,
  defineAgentTool,
  defineConnector,
  type InferAgentToolInput,
  stringEnum,
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
    const { input, connector, logger, run, signal } = context
    const query: string = input.query
    const limit: number = input.limit
    const mode: "quick" | "deep" = input.mode
    const requestedAt: string = input.requestedAt
    const active: boolean = input.filters.active
    const note: string | undefined = input.filters.note
    const knowledge = await connector(knowledgeConnector)
    const results: string[] = knowledge.search(query)

    logger.info("Searching", { limit, mode, active })
    signal.throwIfAborted()
    const runId: string = run.id
    const workflowId: string | undefined = run.kind === "workflow" ? run.workflowId : undefined
    const stepId: string | undefined = run.kind === "workflow" ? run.stepId : undefined
    // @ts-expect-error Managed service-account identity is not part of the tool context.
    run.agentId
    const threadId: string | undefined = run.kind === "conversation" ? run.threadId : undefined

    // @ts-expect-error tool handlers receive no privileged Sixb runtime
    context.sixb

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

void definition
