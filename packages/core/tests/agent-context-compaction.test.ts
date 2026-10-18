import { describe, expect, test } from "bun:test"
import {
  type AgentThreadModelContextMessage,
  estimateAgentContextMessagesTokens,
  estimateAgentContextRequestTokens,
  projectAgentThreadModelContext,
  selectAgentContextCompactionBoundary,
  serializeAgentMessagesForSummary,
  shouldCompactAgentContext,
} from "../src/agents"
import type { AgentContextCheckpointRecord, AgentMessageRecord } from "../src/storage/agents"

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

describe("agent context token estimation", () => {
  test("counts opaque provider state without exposing it to summary generation", () => {
    // Regression proof: remove provider-state from either switch in context-compaction.ts.
    const base = message(2, "assistant", "answer")
    const withState: AgentMessageRecord = {
      ...base,
      parts: [
        ...base.parts,
        { type: "provider-state", providerId: "anthropic", data: { opaque: "secret".repeat(100) } },
      ],
    }
    expect(estimateAgentContextMessagesTokens([withState]).tokens).toBeGreaterThan(
      estimateAgentContextMessagesTokens([base]).tokens
    )
    expect(serializeAgentMessagesForSummary([withState])).toBe(
      serializeAgentMessagesForSummary([base])
    )
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
      estimateAgentContextRequestTokens({ systemPrompt, tools, messages }).tokens
    const bare = estimate("", [])

    expect(bare).toBeGreaterThan(estimateAgentContextMessagesTokens(messages).tokens)
    expect(estimate("system rules ".repeat(40), [])).toBeGreaterThan(bare)
    expect(estimate("", [tool, tool])).toBeGreaterThan(estimate("", [tool]))
  })
})

describe("agent context compaction boundary", () => {
  const turns = [
    message(1, "user", "old question"),
    message(2, "assistant", "old answer"),
    message(3, "user", "recent question"),
    message(4, "assistant", "recent answer"),
    message(5, "user", "current request"),
  ]

  test.each([
    {
      label: "retains the triggering user turn and starts only at a user boundary",
      messages: turns,
      keepRecentTokens: estimateAgentContextMessagesTokens(turns.slice(3)).tokens,
      expected: { summarizedThroughSeq: 2, summarized: [1, 2], retained: [3, 4, 5] },
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
    const boundary = selectAgentContextCompactionBoundary({ messages, keepRecentTokens })
    const selected: unknown = boundary && {
      summarizedThroughSeq: boundary.summarizedThroughSeq,
      summarized: boundary.messagesToSummarize.map((item) => item.seq),
      retained: boundary.retainedMessages.map((item) => item.seq),
    }

    expect(selected).toEqual(expected)
  })
})

describe("agent summary serialization", () => {
  test("quotes durable content, omits reasoning, bounds tool results, and preserves file handles", () => {
    const record: AgentMessageRecord = {
      ...message(2, "assistant", "Result <ready>"),
      parts: [
        { type: "reasoning", text: "private speculation" },
        {
          type: "tool-call",
          toolCallId: "call_1",
          toolName: "lookup",
          input: { id: "quote_1" },
          state: "output-available",
          output: { text: "x".repeat(2_100) },
        },
        {
          type: "file",
          fileRef: {
            blobId: "blob_abc",
            digest: `sha256:${"a".repeat(64)}`,
            sizeBytes: 42,
            fileName: "quote.pdf",
            mediaType: "application/pdf",
          },
        },
        { type: "text", text: "Result <ready>" },
      ],
    }
    const serialized = serializeAgentMessagesForSummary([record])

    expect(serialized).not.toContain("private speculation")
    expect(serialized).toContain('<tool_call id="call_1" name="lookup"')
    expect(serialized).toContain("[truncated ")
    expect(serialized).toContain('message_id="message_2" part_index="2"')
    expect(serialized).toContain('blob_id="blob_abc"')
    expect(serialized).toContain("Result &lt;ready&gt;")
  })
})

describe("agent thread model-context projection", () => {
  const checkpoint: AgentContextCheckpointRecord = {
    id: "checkpoint_1",
    projectId: "project",
    threadId: "thread",
    createdByRunId: "run_2",
    reason: "threshold",
    summary: "User chose <priority> & asked to continue.",
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

  test("prepends one escaped user-role summary to the retained tail", () => {
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
            "The earlier conversation was compacted into this continuation summary.",
            "",
            "<sixb_thread_summary>",
            "User chose &lt;priority&gt; &amp; asked to continue.",
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
