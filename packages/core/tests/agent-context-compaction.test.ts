import { describe, expect, test } from "bun:test"
import {
  AGENT_IMAGE_INPUT_TOKENS,
  type AgentThreadModelContextMessage,
  estimateAgentContextMessagesTokens,
  estimateAgentContextRequestTokens,
  projectAgentThreadModelContext,
  selectAgentContextCompactionBoundary,
  shouldCompactAgentContext,
} from "../src/agents"
import { stableJsonStringify } from "../src/json"
import type { AgentContextCheckpointRecord, AgentMessageRecord } from "../src/storage/agents"

const bytesPerToken = 4

function message(seq: number, role: AgentMessageRecord["role"], text: string): AgentMessageRecord {
  return {
    id: `message_${seq}`,
    projectId: "project",
    threadId: "thread",
    runId: role === "assistant" ? `run_${seq}` : null,
    role,
    seq,
    parts: [{ type: "text", text }],
    contentVersion: 1,
    createdAt: new Date(`2026-08-27T12:${String(seq).padStart(2, "0")}:00.000Z`),
  }
}

/**
 * An OpenAI encrypted reasoning item of `bytes`, as a provider stores it to replay it, with the
 * reasoning tokens its step was billed when its response said.
 */
function encryptedReasoning(bytes: number, tokens?: number) {
  return {
    type: "provider-state" as const,
    providerId: "openai",
    data: { item: { type: "reasoning", summary: [], encrypted_content: "g".repeat(bytes) } },
    ...(tokens === undefined ? {} : { tokens }),
  }
}

/** An Anthropic web fetch tool's result: the page it fetched, which the model reads. */
const fetchedPage = {
  type: "provider-state" as const,
  providerId: "anthropic",
  data: {
    block: {
      type: "web_fetch_tool_result",
      tool_use_id: "srvtoolu_1",
      content: {
        type: "web_fetch_result",
        url: "https://example.com",
        content: "page ".repeat(2_000),
      },
    },
  },
}

describe("agent context token estimation", () => {
  // Reproduce: return its JSON as bytes from providerStateSize whatever its tokens; the 55 KB
  // GPT-6.2 Sol stored 3,613 reasoning tokens in then count as 13,800 tokens. Count its reasoning
  // text in measureMessage whatever countsReasoningText says, and its summary counts on top.
  test("weighs a replayed reasoning item at what its step was billed, and its text not beside it", () => {
    const base = message(2, "assistant", "answer")
    const replayed: AgentMessageRecord = {
      ...base,
      parts: [
        { type: "reasoning", text: "Counting the derangements first.".repeat(20) },
        ...base.parts,
        encryptedReasoning(55_208, 3_613),
      ],
    }
    expect(estimateAgentContextMessagesTokens([replayed], bytesPerToken).tokens).toBe(
      estimateAgentContextMessagesTokens([base], bytesPerToken).tokens + 3_613
    )
  })

  // Reproduce: weigh state with no tokens as nothing in providerStateSize; an item its response
  // never counted, as a thread stored before, then weighs nothing though its provider bills it.
  test("weighs one its response never counted as its JSON, the most it can weigh", () => {
    const base = message(2, "assistant", "answer")
    const item = encryptedReasoning(27_000)
    const uncounted: AgentMessageRecord = { ...base, parts: [...base.parts, item] }
    const asText: AgentMessageRecord = {
      ...base,
      parts: [...base.parts, { type: "text", text: stableJsonStringify(item.data) }],
    }
    expect(estimateAgentContextMessagesTokens([uncounted], bytesPerToken).tokens).toBe(
      estimateAgentContextMessagesTokens([asText], bytesPerToken).tokens
    )
  })

  // Reproduce: weigh state with no tokens as nothing in providerStateSize; the page a provider tool
  // fetched, which the model reads and the provider bills, then counts for nothing.
  test("counts other provider state, as a provider tool's result, as the model reads it", () => {
    const base = message(2, "assistant", "answer")
    const withPage: AgentMessageRecord = { ...base, parts: [...base.parts, fetchedPage] }
    const asText: AgentMessageRecord = {
      ...base,
      parts: [...base.parts, { type: "text", text: stableJsonStringify(fetchedPage.data) }],
    }
    expect(estimateAgentContextMessagesTokens([withPage], bytesPerToken).tokens).toBe(
      estimateAgentContextMessagesTokens([asText], bytesPerToken).tokens
    )
  })
  test("counts how a held call ended as the model reads it", () => {
    // Regression proof: drop approval-outcome from the switch in context-compaction.ts.
    const base = message(3, "user", "Thanks")
    const withOutcome: AgentMessageRecord = {
      ...base,
      parts: [
        {
          type: "approval-outcome",
          approvalId: "apr_1",
          status: "denied",
          call: { kind: "workflow", workflowId: "send-reminders" },
        },
        ...base.parts,
      ],
    }

    expect(estimateAgentContextMessagesTokens([withOutcome], bytesPerToken).tokens).toBeGreaterThan(
      estimateAgentContextMessagesTokens([base], bytesPerToken).tokens
    )
  })
  // Removal proof: share one text budget across the messages, as the estimator once did; the
  // second message's file then counts for nothing although each message sends its own inline.
  test("counts each retained user message's files inline, within that message's budget", () => {
    const withFile = (seq: number): AgentMessageRecord => ({
      ...message(seq, "user", "see attached"),
      parts: [
        { type: "text", text: "see attached" },
        {
          type: "file",
          fileRef: {
            blobId: `blob_${seq}`,
            digest: `sha256:${seq}`,
            sizeBytes: 50 * 1024,
            fileName: "data.csv",
            mediaType: "text/csv",
          },
        },
      ],
    })
    const one = estimateAgentContextMessagesTokens([withFile(1)], bytesPerToken).tokens
    const files = (count: number) =>
      estimateAgentContextMessagesTokens(
        Array.from({ length: count }, (_, index) => withFile(index + 1)),
        bytesPerToken
      ).tokens

    expect(one).toBeGreaterThan(12_800)
    expect(files(6)).toBeGreaterThanOrEqual(6 * one - 6)
  })

  // Removal proofs: drop toolImageTokens from estimateAgentContextMessagesTokens, and 30 viewed
  // screenshots count as their file references alone; drop the image limit, and 150 count beyond
  // the 100 a request inlines.
  test("counts each image a request inlines, its tools' included, up to the request's limit", () => {
    const image = (index: number) => ({
      blobId: `blob_${index}`,
      digest: `sha256:${index}`,
      sizeBytes: 300_000,
      fileName: `shot-${index}.png`,
      mediaType: "image/png",
    })
    const viewed = (seq: number, count: number): AgentMessageRecord => ({
      ...message(seq, "assistant", ""),
      parts: [
        { type: "step-start" },
        ...Array.from({ length: count }, (_, index) => ({
          type: "tool-call" as const,
          toolCallId: `view-${seq}-${index}`,
          toolName: "view_file",
          input: {},
          state: "output-available" as const,
          output: {
            kind: "agentToolResult",
            // The same image twice in one step reaches the model once.
            content: [
              { type: "file", fileRef: image(seq * 1_000 + index) },
              { type: "file", fileRef: image(seq * 1_000 + index) },
            ],
          },
          modelOutput: { type: "text" as const, value: "viewed" },
        })),
      ],
    })
    const bare = (seq: number, count: number): AgentMessageRecord => ({
      ...viewed(seq, count),
      parts: viewed(seq, count).parts.map((part) =>
        part.type === "tool-call" ? { ...part, output: "viewed" } : part
      ),
    })
    const extra = (messages: AgentMessageRecord[], without: AgentMessageRecord[]) =>
      estimateAgentContextMessagesTokens(messages, bytesPerToken).tokens -
      estimateAgentContextMessagesTokens(without, bytesPerToken).tokens

    expect(extra([viewed(2, 30)], [bare(2, 30)])).toBe(30 * AGENT_IMAGE_INPUT_TOKENS)
    expect(extra([viewed(2, 75), viewed(4, 75)], [bare(2, 75), bare(4, 75)])).toBe(
      100 * AGENT_IMAGE_INPUT_TOKENS
    )
  })

  // Removal proof: count stableJsonStringify(part.output) for every call; the publish summary the
  // model read counts as its much larger stored object.
  test("counts a call's output as the model read it", () => {
    const call = (modelOutput?: { type: "text"; value: string }): AgentMessageRecord => ({
      ...message(2, "assistant", ""),
      parts: [
        {
          type: "tool-call",
          toolCallId: "publish",
          toolName: "publish_artifact",
          input: {},
          state: "output-available",
          output: { warnings: "x".repeat(4_000) },
          ...(modelOutput === undefined ? {} : { modelOutput }),
        },
      ],
    })

    expect(estimateAgentContextMessagesTokens([call()], bytesPerToken).tokens).toBeGreaterThan(
      1_000
    )
    expect(
      estimateAgentContextMessagesTokens(
        [call({ type: "text", value: "Published." })],
        bytesPerToken
      ).tokens
    ).toBeLessThan(100)
  })

  test("compacts only above the reserved input budget", () => {
    const inputBudgetTokens = 8_000
    expect(shouldCompactAgentContext({ inputBudgetTokens, estimatedInputTokens: 7_999 })).toBe(
      false
    )
    expect(shouldCompactAgentContext({ inputBudgetTokens, estimatedInputTokens: 8_000 })).toBe(
      false
    )
    expect(shouldCompactAgentContext({ inputBudgetTokens, estimatedInputTokens: 8_001 })).toBe(true)
  })

  test("counts the system prompt and every tool definition on top of the messages", () => {
    const messages = [message(1, "user", "hello"), message(2, "assistant", "world")]
    const tool = {
      name: "lookup",
      description: "Look up a record",
      inputSchema: '{"type":"object"}',
    }
    const estimate = (systemPrompt: string, tools: (typeof tool)[]) =>
      estimateAgentContextRequestTokens({ systemPrompt, tools, messages, bytesPerToken }).tokens
    const bare = estimate("", [])

    expect(bare).toBeGreaterThan(estimateAgentContextMessagesTokens(messages, bytesPerToken).tokens)
    expect(estimate("system rules ".repeat(40), [])).toBeGreaterThan(bare)
    expect(estimate("", [tool, tool])).toBeGreaterThan(estimate("", [tool]))
  })
})

describe("agent context compaction boundary", () => {
  // The selector weighs one message at a time.
  const tailTokens = (tail: readonly AgentMessageRecord[]) =>
    tail.reduce(
      (total, turn) => total + estimateAgentContextMessagesTokens([turn], bytesPerToken).tokens,
      0
    )
  const turns = [
    message(1, "user", "old question"),
    message(2, "assistant", "old answer"),
    message(3, "user", "recent question"),
    message(4, "assistant", "recent answer"),
    message(5, "user", "current request"),
  ]

  test.each([
    {
      label: "keeps the recent turns that fit and starts only at a user boundary",
      messages: turns,
      keepRecentTokens: tailTokens(turns.slice(2)),
      expected: { summarizedThroughSeq: 2, summarized: [1, 2], retained: [3, 4, 5] },
    },
    {
      // Regression proof: select the boundary closest to keepRecentTokens, as the selector once
      // did; it keeps [3, 4, 5], one token past the allowance, and the next turn compacts again.
      label: "never keeps more than the allowance to land closer to it",
      messages: turns,
      keepRecentTokens: tailTokens(turns.slice(2)) - 1,
      expected: { summarizedThroughSeq: 4, summarized: [1, 2, 3, 4], retained: [5] },
    },
    {
      label: "keeps the triggering user turn even when it does not fit",
      messages: turns,
      keepRecentTokens: 0,
      expected: { summarizedThroughSeq: 4, summarized: [1, 2, 3, 4], retained: [5] },
    },
    {
      label: "returns null when no complete older turn can be removed",
      messages: [message(1, "user", "only request")],
      keepRecentTokens: 1,
      expected: null,
    },
    {
      // Regression proof: the former minimum-tail selector returned null because the oversized
      // assistant message pushed the boundary back to the first user message.
      label: "summarizes an oversized completed turn before a short current request",
      messages: [
        message(1, "user", "research this organization"),
        message(2, "assistant", `research results: ${"x".repeat(8_000)}`),
        message(3, "user", "continue on"),
      ],
      keepRecentTokens: 700,
      expected: { summarizedThroughSeq: 2, summarized: [1, 2], retained: [3] },
    },
  ])("$label", ({ messages, keepRecentTokens, expected }) => {
    const boundary = selectAgentContextCompactionBoundary({
      messages,
      keepRecentTokens,
      bytesPerToken,
    })
    const selected: unknown = boundary && {
      summarizedThroughSeq: boundary.summarizedThroughSeq,
      summarized: boundary.messagesToSummarize.map((item) => item.seq),
      retained: boundary.retainedMessages.map((item) => item.seq),
    }

    expect(selected).toEqual(expected)
  })
})

describe("agent thread model-context projection", () => {
  const checkpoint: AgentContextCheckpointRecord = {
    id: "checkpoint_1",
    projectId: "project",
    threadId: "thread",
    createdByRunId: "run_2",
    reason: "threshold",
    summary: 'User chose <priority> & asked to "continue".',
    summaryFormatVersion: 1,
    summarizedThroughSeq: 2,
    observedHeadSeq: 3,
    estimatedInputTokensBefore: 1_000,
    estimatedInputTokensAfter: 300,
    summaryModelId: "test-model",
    createdAt: new Date("2026-08-27T12:00:00.000Z"),
  }

  test("preserves the complete model view when no checkpoint exists", () => {
    const messages = [message(1, "user", "one"), message(2, "assistant", "two")]

    expect(projectAgentThreadModelContext({ checkpoint: null, messages })).toBe(messages)
  })

  test("prepends one user-role summary to the retained tail, its text escaped as text", () => {
    // Regression proof: escape quotes in serializeThreadSummary; the model then reads &quot;
    // wherever the summary quotes the user, and writes it back into the next summary.
    const retained = [message(3, "user", "three"), message(4, "assistant", "four")]
    const projected = projectAgentThreadModelContext({ checkpoint, messages: retained })

    expect(projected).toHaveLength(3)
    expect(projected.slice(1)).toEqual(retained)
    expect(projected[0]).toEqual({
      role: "user",
      parts: [
        {
          type: "text",
          text: [
            "The earlier conversation was compacted into this continuation summary. Its messages are still stored: `sixb threads messages` prints them.",
            "",
            "<sixb_thread_summary>",
            'User chose &lt;priority&gt; &amp; asked to "continue".',
            "</sixb_thread_summary>",
          ].join("\n"),
        },
      ],
    } satisfies AgentThreadModelContextMessage)
  })

  test("rejects a missing, split-turn, or non-contiguous retained tail", () => {
    expect(() => projectAgentThreadModelContext({ checkpoint, messages: [] })).toThrow(
      "has no retained messages"
    )
    expect(() =>
      projectAgentThreadModelContext({
        checkpoint,
        messages: [message(3, "assistant", "split turn")],
      })
    ).toThrow("does not begin at a user turn boundary")
    expect(() =>
      projectAgentThreadModelContext({
        checkpoint,
        messages: [message(4, "user", "gap")],
      })
    ).toThrow("has a sequence gap")
  })
})
