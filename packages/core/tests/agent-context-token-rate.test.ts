import { describe, expect, test } from "bun:test"
import {
  agentContextBytesPerToken,
  agentContextSizeTokens,
  calibrateAgentContextBytesPerToken,
  estimateAgentContextRequestTokens,
  measureAgentContextRequest,
  measureModelRequest,
} from "../src/agents"
import type { AgentMessage } from "../src/agents/message"
import type { ModelMessage, ModelToolSpecification } from "../src/models"

const text = (bytes: number) => "a".repeat(bytes)

/** An outgoing request, weighed and priced as the output ceiling prices it. */
const estimateModelRequestTokens = (
  request: { readonly messages: ModelMessage[]; readonly tools: ModelToolSpecification[] },
  bytesPerToken: number
) => agentContextSizeTokens(measureModelRequest(request), bytesPerToken)

describe("agent context token rate", () => {
  // Removal proof: return DEFAULT_BYTES_PER_TOKEN from agentContextBytesPerToken; Claude requests
  // are then counted at 3 bytes per token and GPT ones at half their real size.
  test.each([
    ["anthropic/claude-haiku-5.5", 2.1],
    ["claude-opus-5-5", 2.1],
    ["us.anthropic.claude-sonnet-4-5-20250929-v1:0", 2.1],
    ["openai/gpt-6.1-terra", 4],
    ["gpt-4o-mini", 4],
    ["openai/o4-mini", 4],
    ["google/gemini-3-flash", 3],
    ["mock-model", 3],
  ])("prices %s at its tokenizer family's rate", (modelId, bytesPerToken) => {
    expect(agentContextBytesPerToken({ modelId })).toBe(bytesPerToken)
  })

  test("prices the same text alike in a stored conversation and an outgoing request", () => {
    // Removal proof: estimate outgoing requests by their serialized JSON again; the two counts of
    // the same 300,000 bytes drift apart by the JSON around them.
    const bytesPerToken = agentContextBytesPerToken({ modelId: "anthropic/claude-haiku-5.5" })
    const body = text(300_000)
    const stored = estimateAgentContextRequestTokens({
      systemPrompt: "System",
      tools: [],
      messages: [{ role: "user", parts: [{ type: "text", text: body }] }],
      bytesPerToken,
    }).tokens
    const outgoing = estimateModelRequestTokens(
      {
        messages: [
          { role: "system", content: "System" },
          { role: "user", content: [{ type: "text", text: body }] },
        ],
        tools: [],
      },
      bytesPerToken
    )

    expect(stored).toBe(Math.ceil(300_006 / 2.1) + 16)
    expect(Math.abs(outgoing - stored)).toBeLessThanOrEqual(8)
  })

  test("counts tool calls, tool results and the tool catalog of an outgoing request", () => {
    const bytesPerToken = 4
    const bare = estimateModelRequestTokens({ messages: [], tools: [] }, bytesPerToken)
    const withTools = estimateModelRequestTokens(
      {
        messages: [
          {
            role: "assistant",
            content: [{ type: "tool-call", toolCallId: "c", toolName: "read", input: { a: 1 } }],
          },
          {
            role: "tool",
            content: [
              {
                type: "tool-result",
                toolCallId: "c",
                toolName: "read",
                output: { type: "text", value: text(4_000) },
              },
            ],
          },
        ],
        tools: [{ name: "read", description: "Read a file", inputSchema: { type: "object" } }],
      },
      bytesPerToken
    )

    expect(withTools - bare).toBeGreaterThan(1_000)
  })
})

describe("agent context rate calibration", () => {
  const request = (bytes: number) => ({
    systemPrompt: text(bytes),
    tools: [],
    messages: [] as AgentMessage[],
  })

  const calibrate = (inputTokens: number) =>
    calibrateAgentContextBytesPerToken({
      bytesPerToken: 2,
      size: measureAgentContextRequest(request(30_000)),
      inputTokens,
    })

  // Removal proof: return input.bytesPerToken from calibrateAgentContextBytesPerToken; a thread
  // whose calls show 2.4 bytes per token keeps being counted at 2.
  test("takes the rate a thread's own call measured", () => {
    // 30,000 bytes over 12,500 text tokens, plus the request's 8.
    expect(calibrate(12_508)).toBe(2.4)
  })

  // Removal proof: drop the clamp; one call carrying an unreplayed image measures 0.5 bytes per
  // token and the next estimate quadruples, or one whose stored bytes bill for less measures 15.
  test("lets a measured rate fall to half the family's, and rise only a quarter", () => {
    expect(calibrate(60_008)).toBe(1)
    expect(calibrate(2_008)).toBe(2.5)
    // Reproduce: clamp upward at twice the family rate again; 3 bytes per token pass through.
    expect(calibrate(10_008)).toBe(2.5)
  })

  // Removal proof: drop CALIBRATION_MIN_TEXT_TOKENS; a 600-byte call's overheads set the rate.
  test("keeps the family rate when the call is too small to measure", () => {
    expect(
      calibrateAgentContextBytesPerToken({
        bytesPerToken: 2,
        size: measureAgentContextRequest(request(600)),
        inputTokens: 300,
      })
    ).toBe(2)
  })
})
