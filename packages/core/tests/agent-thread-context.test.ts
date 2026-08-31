import { describe, expect, test } from "bun:test"
import { type AgentThreadModelContextMessage, projectAgentThreadModelContext } from "../src/agents"
import type { AgentContextCheckpointRecord, AgentMessageRecord } from "../src/storage/agents"

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
    createdAt: new Date(`2026-08-27T12:0${seq}:00.000Z`),
  }
}

describe("agent thread model-context projection", () => {
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
