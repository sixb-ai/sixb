import { describe, expect, test } from "bun:test"
import type { PrepareModelStepInput } from "@sixb/core/internal/agents"
import { resolveLanguageModel } from "@sixb/core/internal/model-execution"
import {
  defineLanguageModel,
  type ModelMessage,
  ModelProviderError,
  type ModelStep,
} from "@sixb/core/models"
import {
  type AgentContextBudget,
  estimateAgentRequestTokens,
  prepareAgentModel,
} from "../src/context-budget"
import {
  type CompactConversationBeforeTurn,
  clearedToolResultText,
  createAgentContextGuard,
} from "../src/context-guard"
import { testStream, WorkerTestModel } from "./worker-model-fixture"

/** A model whose input stops at `inputBudgetTokens`, counted at 3 bytes per token. */
function limited(inputBudgetTokens: number): AgentContextBudget {
  return {
    windowTokens: inputBudgetTokens + 16_384,
    inputBudgetTokens,
    reserveTokens: 16_384,
    keepRecentTokens: 20_000,
    source: "model",
    bytesPerToken: 3,
  }
}

/** A 100,000-token window: 83,616 tokens of input at most. */
const BUDGET = limited(83_616)

const HEAD: readonly ModelMessage[] = [
  { role: "system", content: "You read chapters." },
  { role: "user", content: [{ type: "text", text: "Read every chapter." }] },
]

/** One step that read a chapter: the call, then its result. */
function readStep(index: number, bytes: number): ModelMessage[] {
  return [
    {
      role: "assistant",
      content: [
        { type: "tool-call", toolCallId: `call_${index}`, toolName: "read", input: { index } },
      ],
    },
    {
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: `call_${index}`,
          toolName: "read",
          output: { type: "text", value: `chapter ${index}\n${"x".repeat(bytes)}` },
        },
      ],
    },
  ]
}

/** The steps a loop completed, without usage: the guard estimates their requests whole. */
function steps(count: number, usage: ModelStep["usage"] = {}): ModelStep[] {
  return Array.from({ length: count }, (_, index) => ({
    content: [],
    finishReason: "tool-calls",
    usage,
    responseId: `response_${index}`,
    cost: { status: "unpriceable", reason: "missing-usage" },
  }))
}

function step(
  stepIndex: number,
  messages: readonly ModelMessage[],
  completed = steps(stepIndex)
): PrepareModelStepInput {
  return {
    stepIndex,
    messages,
    steps: completed,
    model: undefined as never,
    signal: new AbortController().signal,
  }
}

function outputs(messages: readonly ModelMessage[]): string[] {
  return messages.flatMap((message) =>
    message.role === "tool"
      ? message.content.map((part) =>
          typeof part.output.value === "string" ? part.output.value : ""
        )
      : []
  )
}

function tokens(messages: readonly ModelMessage[]): number {
  return estimateAgentRequestTokens({ messages, tools: [] }, BUDGET.bytesPerToken)
}

describe("createAgentContextGuard", () => {
  // Reproduce: return undefined from ContextGuard.reduce; the request then goes out at about
  // 80,000 tokens, past its 60,000-token limit. Keep the three most recent whatever the aim
  // (KEPT_TOOL_RESULTS = 3); the batch then stops at 40,000 tokens, and the next steps clear again.
  test("clears the oldest results the model read in one batch, down to 60 % of the limit", async () => {
    const guard = createAgentContextGuard({ budget: limited(60_000), tools: [] })
    await guard.prepareStep(step(0, HEAD))
    // Eight chapters of about 10,000 tokens each; the model has not read the last one yet.
    const messages = [...HEAD, ...Array.from({ length: 8 }, (_, i) => readStep(i, 30_000)).flat()]

    const prepared = await guard.prepareStep(step(8, messages))

    // Oldest first, through the three most recent it read since the aim needs it: the newest
    // it read stays, and so does the one it has not read.
    const cleared = outputs(prepared?.messages ?? messages)
    expect(cleared.slice(0, 5)).toEqual(Array(5).fill(clearedToolResultText("read")))
    expect(cleared.slice(5).every((output) => output.startsWith("chapter "))).toBe(true)
    expect(tokens(prepared?.messages ?? messages)).toBeLessThanOrEqual(36_000)
  })

  // Reproduce: clear newest first in ContextGuard.clear; the three most recent are then cleared
  // although the older ones were enough.
  test("keeps the three most recent results it read when clearing the older ones reaches the aim", async () => {
    const guard = createAgentContextGuard({ budget: limited(60_000), tools: [] })
    await guard.prepareStep(step(0, HEAD))
    // Twelve chapters of about 5,500 tokens each, the last one unread.
    const messages = [...HEAD, ...Array.from({ length: 12 }, (_, i) => readStep(i, 16_500)).flat()]

    const prepared = await guard.prepareStep(step(12, messages))

    const cleared = outputs(prepared?.messages ?? messages)
    expect(cleared[0]).toBe(clearedToolResultText("read"))
    expect(cleared.slice(-4).every((output) => output.startsWith("chapter "))).toBe(true)
    expect(tokens(prepared?.messages ?? messages)).toBeLessThanOrEqual(36_000)
  })

  // Reproduce: return undefined from prepareStep at step 0; a turn whose history replays results
  // an earlier turn cleared then sends them all again, past its 60,000-token limit.
  test("weighs a turn's first call too, from its whole request", async () => {
    const guard = createAgentContextGuard({ budget: limited(60_000), tools: [] })
    const messages = [
      ...HEAD,
      ...Array.from({ length: 8 }, (_, i) => readStep(i, 30_000)).flat(),
      { role: "assistant" as const, content: [{ type: "text" as const, text: "Read them all." }] },
      { role: "user" as const, content: [{ type: "text" as const, text: "Thanks." }] },
    ]

    const prepared = await guard.prepareStep(step(0, messages))

    expect(outputs(prepared?.messages ?? messages)[0]).toBe(clearedToolResultText("read"))
    expect(tokens(prepared?.messages ?? messages)).toBeLessThanOrEqual(60_000)
  })

  // Reproduce: set CLEARED_AT_LEAST_SHARE to 0; the four older small results are then cleared,
  // which breaks the cache to free about 1,900 tokens, and the earlier turn stays.
  test("compacts rather than clear too little to be worth the cache it breaks", async () => {
    let compactions = 0
    const summarized: ModelMessage[] = [
      { role: "system", content: "You read chapters." },
      { role: "user", content: [{ type: "text", text: "<sixb_thread_summary>…" }] },
      { role: "user", content: [{ type: "text", text: "Read every chapter." }] },
    ]
    const head: ModelMessage[] = [
      { role: "system", content: "You read chapters." },
      { role: "user", content: [{ type: "text", text: `Earlier: ${"y".repeat(90_000)}` }] },
      { role: "assistant", content: [{ type: "text", text: "Done earlier." }] },
      { role: "user", content: [{ type: "text", text: "Read every chapter." }] },
    ]
    const turn = Array.from({ length: 6 }, (_, i) => readStep(i, 1_500)).flat()
    const messages = [...head, ...turn]
    // 600 tokens past the limit: clearing the results it may would bring it under.
    const guard = createAgentContextGuard({
      budget: limited(tokens(messages) - 600),
      tools: [],
      compact: async () => {
        compactions += 1
        return summarized
      },
    })
    await guard.prepareStep(step(0, head))

    const prepared = await guard.prepareStep(step(6, messages))

    expect(compactions).toBe(1)
    expect(prepared?.messages).toEqual([...summarized, ...turn])
  })

  // Reproduce: skip the compact call in ContextGuard.reduce; the earlier turn then stays, and the
  // request goes out past its limit.
  test("compacts what came before the turn, and keeps the turn's steps as they are", async () => {
    const reasons: string[] = []
    const summarized: ModelMessage[] = [
      { role: "system", content: "You read chapters." },
      { role: "user", content: [{ type: "text", text: "<sixb_thread_summary>…" }] },
      { role: "user", content: [{ type: "text", text: "Read every chapter." }] },
    ]
    const compact: CompactConversationBeforeTurn = async ({ reason }) => {
      reasons.push(reason)
      return summarized
    }
    const guard = createAgentContextGuard({ budget: limited(50_000), tools: [], compact })
    const head: ModelMessage[] = [
      { role: "system", content: "You read chapters." },
      { role: "user", content: [{ type: "text", text: `Earlier: ${"y".repeat(90_000)}` }] },
      { role: "assistant", content: [{ type: "text", text: "Done earlier." }] },
      { role: "user", content: [{ type: "text", text: "Read every chapter." }] },
    ]
    await guard.prepareStep(step(0, head))
    const turn = Array.from({ length: 3 }, (_, i) => readStep(i, 30_000)).flat()

    const prepared = await guard.prepareStep(step(3, [...head, ...turn]))

    expect(reasons).toEqual(["threshold"])
    expect(prepared?.messages).toEqual([...summarized, ...turn])
  })

  // Reproduce: drop the cutUnread call in ContextGuard.reduce; the step's 300,000 bytes then go
  // out past the model's 83,616-token input limit.
  test("cuts the results the model has not read to fit the limit", async () => {
    const guard = createAgentContextGuard({ budget: BUDGET, tools: [] })
    await guard.prepareStep(step(0, HEAD))
    const parallel: ModelMessage[] = [
      {
        role: "assistant",
        content: [0, 1, 2].map((index) => ({
          type: "tool-call" as const,
          toolCallId: `call_${index}`,
          toolName: "read",
          input: { index },
        })),
      },
      {
        role: "tool",
        content: [0, 1, 2].map((index) => ({
          type: "tool-result" as const,
          toolCallId: `call_${index}`,
          toolName: "read",
          output: { type: "text" as const, value: `chapter ${index}\n${"z\n".repeat(50_000)}` },
        })),
      },
    ]

    const prepared = await guard.prepareStep(step(1, [...HEAD, ...parallel]))

    const cut = outputs(prepared?.messages ?? [])
    expect(cut).toHaveLength(3)
    for (const [index, output] of cut.entries()) {
      expect(output.startsWith(`chapter ${index}\nz\n`)).toBe(true)
      expect(output).toContain("[Cut to fit the model's context:")
    }
    expect(tokens(prepared?.messages ?? [])).toBeLessThanOrEqual(BUDGET.inputBudgetTokens)
  })

  // Reproduce: measure every request whole in ContextGuard.measure; the small request then looks
  // far under its limit, though the last call read 90,000 tokens.
  test("weighs a request from what the last call really read", async () => {
    const guard = createAgentContextGuard({ budget: limited(60_000), tools: [] })
    const messages = [...HEAD, ...Array.from({ length: 6 }, (_, i) => readStep(i, 3_000)).flat()]
    await guard.prepareStep(step(0, HEAD))
    for (let index = 1; index < 6; index += 1) {
      await guard.prepareStep(step(index, messages.slice(0, HEAD.length + 2 * index)))
    }

    const prepared = await guard.prepareStep(
      step(6, messages, steps(6, { inputTokens: 90_000, outputTokens: 10 }))
    )

    expect(outputs(prepared?.messages ?? messages)[0]).toBe(clearedToolResultText("read"))
  })

  // Reproduce: return undefined from recoverStep whatever the error; the rejected call then fails
  // the turn instead of being asked again compacted.
  test("compacts a request the provider rejected as too long, and nothing else", async () => {
    const reasons: string[] = []
    const guard = createAgentContextGuard({
      budget: BUDGET,
      tools: [],
      compact: async ({ reason }) => {
        reasons.push(reason)
        return HEAD
      },
    })
    const head: ModelMessage[] = [
      ...HEAD.slice(0, 1),
      // About 80,000 tokens by the estimate, which the provider counted past the window.
      { role: "user", content: [{ type: "text", text: `Earlier: ${"y".repeat(240_000)}` }] },
      { role: "assistant", content: [{ type: "text", text: "Done earlier." }] },
      HEAD[1]!,
    ]
    await guard.prepareStep(step(0, head))
    const messages = [...head, ...readStep(0, 3_000)]
    const recover = (error: unknown) => guard.recoverStep({ ...step(1, messages), error })

    expect(await recover(new Error("[test] The provider is down."))).toBeUndefined()
    expect(reasons).toEqual([])

    const recovered = await recover(
      new ModelProviderError("[test] Too long.", "test", "test", {
        status: 400,
        reason: "context-window-exceeded",
      })
    )
    expect(reasons).toEqual(["overflow"])
    expect(recovered?.messages).toEqual([...HEAD, ...readStep(0, 3_000)])
  })

  // Reproduce: count what changed at the rejection's rate as a whole in
  // ContextGuard.projectedTokens (`fixed + ceil((added - removed) * scale)`); the compacted
  // request then looks about 47,000 tokens long and goes out uncut, though the provider counts its
  // new result past the limit.
  test("weighs a rejected request after compaction at the rate the rejection showed", async () => {
    const guard = createAgentContextGuard({
      budget: BUDGET,
      tools: [],
      compact: async () => HEAD,
    })
    const head: ModelMessage[] = [
      HEAD[0]!,
      { role: "user", content: [{ type: "text", text: `Earlier: ${"y".repeat(36_000)}` }] },
      { role: "assistant", content: [{ type: "text", text: "Done earlier." }] },
      HEAD[1]!,
    ]
    await guard.prepareStep(step(0, head))
    // The last call read 12,100 tokens; its 60 KB result, 20,000 by the estimate, took the request
    // past the 100,000-token window: the provider counts what was added about 4.4 times higher.
    const messages = [...head, ...readStep(0, 60_000)]
    const recovered = await guard.recoverStep({
      ...step(1, messages, steps(1, { inputTokens: 12_100 })),
      error: new ModelProviderError("[test] Too long.", "test", "test", {
        reason: "context-window-exceeded",
      }),
    })

    const sent = recovered?.messages ?? []
    expect(outputs(sent)[0]).toContain("[Cut to fit the model's context:")
    expect(tokens(sent) * 4.4).toBeLessThanOrEqual(BUDGET.inputBudgetTokens)
  })

  // Reproduce: ignore `usage` in recoverStep (count the rejected request at the window); an answer
  // the window cut then sets the rate about ten times higher, and the next step clears for nothing.
  test("rates a turn from what the provider counted when the answer filled the window", async () => {
    const guard = createAgentContextGuard({ budget: BUDGET, tools: [] })
    const first = [...HEAD, ...readStep(0, 30_000)]
    const second = [...first, ...readStep(1, 30_000)]
    const read = (messages: readonly ModelMessage[]) => ({ inputTokens: tokens(messages) })

    await guard.prepareStep(step(0, HEAD))
    await guard.prepareStep(step(1, first, steps(1, read(HEAD))))
    // The input fit: the answer is what filled the window.
    await guard.recoverStep({
      ...step(1, first, steps(1, read(HEAD))),
      usage: read(first),
      error: new ModelProviderError("[test] Window filled.", "test", "test", {
        reason: "context-window-exceeded",
      }),
    })

    const completed = [...steps(1, read(HEAD)), ...steps(1, read(first))]
    expect(await guard.prepareStep(step(2, second, completed))).toBeUndefined()
  })
})

describe("the rate a guard weighs calls at", () => {
  test("follows the first call an unmeasured model counted", async () => {
    // Reproduce: leave measuredBytesPerToken out of the guard's rate in ContextGuard; the call is
    // weighed at the default 2 bytes per token, 120,000 tokens, and its chapter cleared.
    const counting = new WorkerTestModel({
      definition: defineLanguageModel({
        kind: "language",
        providerId: "mock",
        modelId: "sparse",
        capabilities: {},
        contextWindow: 100_000,
        maxOutputTokens: 16_384,
      }),
      // A sparse tokenizer: 4 bytes per token, as OpenAI's measures about 4.4.
      stream: async (request) =>
        testStream([
          {
            type: "finish",
            finishReason: "stop",
            usage: { inputTokens: estimateAgentRequestTokens(request, 4), outputTokens: 10 },
          },
        ]),
    })
    const prepared = prepareAgentModel({ model: await resolveLanguageModel(counting) })
    const first = await prepared.model.stream({
      callId: "first",
      tools: [],
      messages: [...HEAD, ...readStep(0, 100_000)],
      signal: new AbortController().signal,
    })
    for await (const _event of first.events) {
      // Each event is read, as the model loop reads them.
    }

    const guard = createAgentContextGuard({
      budget: prepared.budget,
      tools: [],
      measuredBytesPerToken: prepared.measuredBytesPerToken,
    })
    // 240,000 bytes: 60,000 tokens at the 4 the first call measured, under the 83,616 limit.
    const reduced = await guard.prepareStep(step(0, [...HEAD, ...readStep(1, 240_000)]))

    expect(prepared.budget.bytesPerToken).toBe(2)
    expect(prepared.measuredBytesPerToken()).toBeCloseTo(4, 2)
    expect(reduced).toBeUndefined()
  })
})
