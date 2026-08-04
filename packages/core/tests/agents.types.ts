import {
  type AgentToolDefinition,
  type AgentToolRunContext,
  defineAgent,
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
    const agentId: string = run.agentId
    const threadId: string | undefined = run.threadId

    // @ts-expect-error tool handlers receive no privileged Sixb runtime
    context.sixb

    return { results, note: note ?? null, requestedAt, runId, agentId, threadId: threadId ?? null }
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

defineAgent("research", {
  name: "Research",
  model: {} as Parameters<typeof defineAgent>[1]["model"],
  instructions: "Research questions.",
  tools: [searchKnowledge],
})

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

void definition
