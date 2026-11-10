import { AgentToolPublicError, type JsonValue } from "@sixb/core"
import {
  type AgentRunModels,
  type AgentRunWebPlan,
  webDomainPolicy,
} from "@sixb/core/internal/agents"
import { isSixbError } from "@sixb/core/internal/errors"
import type { JsonObject, ModelTool, ModelToolOutput, WebSearchHit } from "@sixb/core/models"
import { AgentToolExecutionError } from "../errors"
import { agentToolErrorText } from "../model-adapters"

/** How many results one search asks for. */
const MAX_RESULTS = 8
const MAX_QUERY_CHARACTERS = 2_000

export const WEB_SEARCH_TOOL_SPEC = {
  name: "web_search",
  strict: true,
  description:
    "Search the web for current or external information. Returns up to 8 results, each a title, URL, date and snippet.",
  inputSchema: {
    type: "object",
    properties: { query: { type: "string", minLength: 1, maxLength: MAX_QUERY_CHARACTERS } },
    required: ["query"],
    additionalProperties: false,
  } satisfies JsonObject,
} as const

export interface WebSearchToolInput {
  readonly query: string
}

/** What a search stores, and the app shows: its query and the results the domain lists kept. */
export interface WebSearchToolOutput {
  readonly query: string
  readonly results: readonly WebSearchHit[]
}

/**
 * Search through the run's session, which calls the project's web search model where the project
 * is, and drop the results its domain lists refuse.
 */
export function createWebSearchTool(input: {
  readonly search: AgentRunModels["webSearch"]
  readonly web: AgentRunWebPlan
}): ModelTool<WebSearchToolInput> {
  const { allowedDomains, blockedDomains } = input.web
  const domains = {
    ...(allowedDomains ? { allowedDomains } : {}),
    ...(blockedDomains ? { blockedDomains } : {}),
  }
  const policy = webDomainPolicy(domains)

  return {
    ...WEB_SEARCH_TOOL_SPEC,
    parseInput: parseWebSearchInput,
    async execute({ query }, { signal }): Promise<JsonValue> {
      let found: readonly WebSearchHit[]
      try {
        const result = await input.search({ query, maxResults: MAX_RESULTS, ...domains }, signal)
        found = result.results
      } catch (error) {
        signal.throwIfAborted()
        throw webSearchError(error)
      }

      // The domains reach the provider as a hint only: each result is checked here again.
      const results = found.filter((hit) => !policy.refuses(new URL(hit.url)))
      const output: WebSearchToolOutput = { query, results }
      return output as unknown as JsonValue
    },
    toModelOutput: (output) => webSearchModelOutput(output as unknown as WebSearchToolOutput),
    errorText: agentToolErrorText,
  }
}

/**
 * The results as the model reads them: a numbered list, wrapped as untrusted web content. Read
 * from the stored output alone, so a replayed conversation sends the same bytes.
 */
export function webSearchModelOutput(output: WebSearchToolOutput): ModelToolOutput {
  if (output.results.length === 0) return { type: "text", value: "No results." }

  const lines = output.results.map((hit, index) => {
    const date = hit.publishedAt ? ` (${hit.publishedAt.slice(0, 10)})` : ""
    const url = oneLine(hit.url)
    const heading = `${index + 1}. ${oneLine(hit.title) || url} — ${url}${date}`
    const snippet = oneLine(hit.snippet)
    return snippet ? `${heading}\n   ${snippet}` : heading
  })

  return {
    type: "text",
    value: `<web_content source="web_search" untrusted="true">\n${lines.join("\n")}\n</web_content>`,
  }
}

function parseWebSearchInput(value: unknown): WebSearchToolInput {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw publicError("input must be an object.")
  }

  for (const key of Object.keys(value)) {
    if (key !== "query") throw publicError(`input contains unknown property '${key}'.`)
  }

  const query = (value as { readonly query?: unknown }).query
  if (typeof query !== "string" || !query.trim()) {
    throw publicError("query must be a nonempty string.")
  }
  if (query.length > MAX_QUERY_CHARACTERS) {
    throw publicError(`query must be at most ${MAX_QUERY_CHARACTERS} characters.`)
  }

  return { query: query.trim() }
}

/** A limit refusal is the model's to know; anything else stays generic. */
function webSearchError(error: unknown): Error {
  if (
    isSixbError(error) &&
    (error.code === "ai.usage_limit_exceeded" || error.code === "ai.usage_limit_unavailable")
  ) {
    return publicError("is blocked by the project's AI usage limits.")
  }

  return new AgentToolExecutionError("web_search", { cause: error })
}

/** Web text on one line, unable to close the wrapper it sits in. */
function oneLine(text: string): string {
  return text
    .replace(/\s+/g, " ")
    .trim()
    .replace(/<(\/?)web_content/gi, "&lt;$1web_content")
}

function publicError(message: string): AgentToolPublicError {
  return new AgentToolPublicError(`[SixbAgent] web_search ${message}`)
}
