import { describe, expect, test } from "bun:test"
import {
  estimateAgentContextMessagesTokens,
  estimateAgentContextRequestTokens,
  selectAgentContextCompactionBoundary,
  serializeAgentMessagesForSummary,
  shouldCompactAgentContext,
} from "../src/agents"
import type { AgentMessageRecord } from "../src/storage/agents"

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
  test("compacts only above the reserved input budget", () => {
    const config = { windowTokens: 10_000, reserveTokens: 2_000 }
    expect(shouldCompactAgentContext({ ...config, estimatedInputTokens: 7_999 })).toBe(false)
    expect(shouldCompactAgentContext({ ...config, estimatedInputTokens: 8_000 })).toBe(false)
    expect(shouldCompactAgentContext({ ...config, estimatedInputTokens: 8_001 })).toBe(true)
  })

  test("estimates the complete request shape deterministically", () => {
    const messages = [message(1, "user", "hello"), message(2, "assistant", "world")]
    const first = estimateAgentContextRequestTokens({
      systemPrompt: "system rules",
      tools: [
        { name: "lookup", description: "Look up a record", inputSchema: '{"type":"object"}' },
      ],
      messages,
    })
    const second = estimateAgentContextRequestTokens({
      systemPrompt: "system rules",
      tools: [
        { name: "lookup", description: "Look up a record", inputSchema: '{"type":"object"}' },
      ],
      messages,
    })

    expect(first).toEqual(second)
    expect(first.estimatorVersion).toBe(1)
    expect(first.tokens).toBeGreaterThan(estimateAgentContextMessagesTokens(messages).tokens)
  })
})

describe("agent context compaction boundary", () => {
  test("retains the triggering user turn and starts only at a user boundary", () => {
    const messages = [
      message(1, "user", "old question"),
      message(2, "assistant", "old answer"),
      message(3, "user", "recent question"),
      message(4, "assistant", "recent answer"),
      message(5, "user", "current request"),
    ]
    const recentTurnTokens = estimateAgentContextMessagesTokens(messages.slice(3)).tokens
    const boundary = selectAgentContextCompactionBoundary({
      messages,
      keepRecentTokens: recentTurnTokens,
    })

    expect(boundary?.summarizedThroughSeq).toBe(2)
    expect(boundary?.messagesToSummarize.map((item) => item.seq)).toEqual([1, 2])
    expect(boundary?.retainedMessages.map((item) => item.seq)).toEqual([3, 4, 5])
    expect(boundary?.retainedMessages[0]?.role).toBe("user")
  })

  test("returns null when no complete older turn can be removed", () => {
    expect(
      selectAgentContextCompactionBoundary({
        messages: [message(1, "user", "only request")],
        keepRecentTokens: 1,
      })
    ).toBeNull()
  })

  test("summarizes an oversized completed turn before a short current request", () => {
    const messages = [
      message(1, "user", "research this organization"),
      message(2, "assistant", `research results: ${"x".repeat(8_000)}`),
      message(3, "user", "continue on"),
    ]
    const boundary = selectAgentContextCompactionBoundary({
      messages,
      keepRecentTokens: 700,
    })

    // Regression proof: the former minimum-tail selector returned null because the oversized
    // assistant message pushed the boundary back to the first user message.
    expect(boundary?.summarizedThroughSeq).toBe(2)
    expect(boundary?.messagesToSummarize.map((item) => item.seq)).toEqual([1, 2])
    expect(boundary?.retainedMessages.map((item) => item.seq)).toEqual([3])
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
