import { describe, expect, test } from "bun:test"
import {
  AGENT_IMAGE_INPUT_TOKENS,
  type AgentThreadModelContextMessage,
  estimateAgentContextMessagesTokens,
  estimateAgentContextRequestTokens,
  projectAgentThreadModelContext,
  selectAgentContextCompactionBoundary,
  serializeAgentMessagesForSummary,
  shouldCompactAgentContext,
} from "../src/agents"
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
    expect(estimateAgentContextMessagesTokens([withState], bytesPerToken).tokens).toBeGreaterThan(
      estimateAgentContextMessagesTokens([base], bytesPerToken).tokens
    )
    expect(serializeAgentMessagesForSummary([withState])).toBe(
      serializeAgentMessagesForSummary([base])
    )
  })
  test("counts and summarizes how a held call ended as the model reads it", () => {
    // Regression proof: drop approval-outcome from either switch in context-compaction.ts.
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
    expect(serializeAgentMessagesForSummary([withOutcome])).toContain(
      "The user denied `workflows start send-reminders`. It did not run."
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

  test("compacts only above the context target", () => {
    const targetTokens = 8_000
    expect(shouldCompactAgentContext({ targetTokens, estimatedInputTokens: 7_999 })).toBe(false)
    expect(shouldCompactAgentContext({ targetTokens, estimatedInputTokens: 8_000 })).toBe(false)
    expect(shouldCompactAgentContext({ targetTokens, estimatedInputTokens: 8_001 })).toBe(true)
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
      // The selector weighs one message at a time.
      keepRecentTokens: turns
        .slice(3)
        .reduce(
          (total, turn) => total + estimateAgentContextMessagesTokens([turn], bytesPerToken).tokens,
          0
        ),
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
