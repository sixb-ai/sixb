import { describe, expect, test } from "bun:test"
import { withBilledReasoning } from "../src/agents/replayed-reasoning"
import type { ModelAssistantPart } from "../src/models"

/** An encrypted reasoning item of `bytes`, as the Responses protocol stores it to replay it. */
function item(bytes: number): ModelAssistantPart {
  return {
    type: "provider-state",
    providerId: "openai",
    data: { item: { type: "reasoning", summary: [], encrypted_content: "g".repeat(bytes) } },
  }
}

function tokensOf(content: readonly ModelAssistantPart[]): (number | undefined)[] {
  return content.map((part) => (part.type === "provider-state" ? part.tokens : undefined))
}

describe("withBilledReasoning", () => {
  // Reproduce: give each item the step's whole count, or share it evenly; three items then weigh
  // 3,000 tokens each, or the 18 KB one as little as the 2 KB one.
  test("shares the step's reasoning tokens among its items by their bytes, to the token", () => {
    const content = withBilledReasoning(
      [item(2_000), { type: "text", text: "Done." }, item(18_000), item(10_000)],
      3_000
    )

    const shares = tokensOf(content)
    // By each item's JSON, its envelope's 63 bytes included.
    expect(shares).toEqual([205, undefined, 1_795, 1_000])
    expect(shares.reduce<number>((total, tokens) => total + (tokens ?? 0), 0)).toBe(3_000)
  })

  // Reproduce: test `provider-state` alone in withBilledReasoning; a provider tool's result, which
  // the model reads as content, then takes a share of the reasoning and loses its own weight.
  test("leaves any other provider state as it is", () => {
    const fetched: ModelAssistantPart = {
      type: "provider-state",
      providerId: "anthropic",
      data: { block: { type: "web_fetch_tool_result", content: "page" } },
    }

    expect(tokensOf(withBilledReasoning([fetched, item(4_000)], 185))).toEqual([undefined, 185])
  })

  // Reproduce: count a missing count as 0 in withBilledReasoning; a step whose provider never said
  // what it reasoned then replays its items as weighing nothing.
  test("leaves the items as they are when the step's count is unknown", () => {
    const content = [item(27_000)]

    expect(withBilledReasoning(content, undefined)).toBe(content)
  })

  test("weighs items of a step billed no reasoning at nothing", () => {
    expect(tokensOf(withBilledReasoning([item(3_000), item(3_000)], 0))).toEqual([0, 0])
  })
})
