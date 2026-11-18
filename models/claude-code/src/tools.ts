import type { McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import {
  CallToolRequestSchema,
  type CallToolResult,
  ListToolsRequestSchema,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js"
import type { JsonObject, ModelToolSpecification } from "@sixb/core/models"
import { ERROR_PREFIX } from "./turn"

const SERVER_NAME = "sixb"

/** Claude Code names a tool from an MCP server `mcp__<server>__<tool>`. */
export const TOOL_PREFIX = `mcp__${SERVER_NAME}__`

/**
 * Sixb's tools, offered to Claude Code as an in-process MCP server so the model can call them.
 *
 * Sixb runs its tools itself: a call ends the model call, and the next one resumes the session with
 * the results. Until then Claude Code has already started the call, so the handler holds it, and
 * answers only once `released` aborts, when the session has been interrupted and nothing reads it.
 */
export function sixbToolServer(
  tools: readonly ModelToolSpecification[],
  released: AbortSignal
): McpSdkServerConfigWithInstance {
  const listed: Tool[] = tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: objectSchema(tool),
    // Every tool in the prompt from the start, never deferred behind a tool search.
    _meta: { "anthropic/alwaysLoad": true },
  }))

  const server = new McpServer(
    { name: SERVER_NAME, version: "1.0.0" },
    { capabilities: { tools: {} } }
  )
  server.server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: listed }))
  server.server.setRequestHandler(
    CallToolRequestSchema,
    () =>
      new Promise<CallToolResult>((resolve) => {
        const answer = () =>
          resolve({ content: [{ type: "text", text: "Sixb runs this tool." }], isError: true })

        if (released.aborted) answer()
        else released.addEventListener("abort", answer, { once: true })
      })
  )

  return { type: "sdk", name: SERVER_NAME, instance: server }
}

function objectSchema(tool: ModelToolSpecification): Tool["inputSchema"] {
  const schema: JsonObject = tool.inputSchema
  if (schema.type !== "object") {
    throw new TypeError(
      `${ERROR_PREFIX} Tool '${tool.name}' must take an object: its input schema's type is not 'object'.`
    )
  }

  return { ...schema, type: "object" }
}
