import { describe, expect, test } from "bun:test"
import type { ModelMessage } from "@sixb/core/models"
import { planTurn } from "../src/turn"

const session = { sessionId: "session-1", at: "entry-9" }

const system: ModelMessage = { role: "system", content: "Be terse." }

function user(text: string): ModelMessage {
  return { role: "user", content: [{ type: "text", text }] }
}

describe("planTurn", () => {
  test("starts a session with only the user's message when nothing came before", () => {
    const turn = planTurn([system, user("Hello")])

    expect(turn.systemPrompt).toBe("Be terse.")
    expect(turn.resume).toBeUndefined()
    expect(turn.start).toEqual([{ type: "text", text: "Hello" }])
  })

  test("resumes the session of the last answer with the tool results it waits for", () => {
    const turn = planTurn([
      system,
      user("Stock of item 7?"),
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "toolu_1",
            toolName: "lookup",
            input: { item: "7" },
            providerData: { "claude-code": session },
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "toolu_1",
            toolName: "lookup",
            output: { type: "text", value: "12 in stock" },
          },
        ],
      },
    ])

    expect(turn.resume).toEqual({
      session,
      content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "12 in stock" }],
    })
  })

  test("resumes with the next user message, after the tool results that came with it", () => {
    const turn = planTurn([
      user("Hi"),
      {
        role: "assistant",
        content: [{ type: "text", text: "Hello.", providerData: { "claude-code": session } }],
      },
      user("And now?"),
      user("Also this."),
    ])

    expect(turn.resume?.content).toEqual([
      { type: "text", text: "And now?" },
      { type: "text", text: "Also this." },
    ])
  })

  test("starts over when the last answer did not come from Claude Code", () => {
    const turn = planTurn([
      user("Hi"),
      {
        role: "assistant",
        content: [{ type: "text", text: "Hello.", providerData: { anthropic: session } }],
      },
      user("And now?"),
    ])

    expect(turn.resume).toBeUndefined()
  })

  test("writes the earlier conversation as a transcript for a new session", () => {
    const turn = planTurn([
      system,
      user("Stock of item 7?"),
      {
        role: "assistant",
        content: [
          { type: "reasoning", text: "Not replayed." },
          { type: "text", text: "Checking." },
          { type: "tool-call", toolCallId: "toolu_1", toolName: "lookup", input: { item: "7" } },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "toolu_1",
            toolName: "lookup",
            output: { type: "error-text", value: "lookup failed" },
          },
        ],
      },
    ])

    expect(turn.resume).toBeUndefined()
    const [transcript, continuation] = turn.start
    expect(transcript?.text).toContain("<user>\nStock of item 7?\n</user>")
    expect(transcript?.text).toContain(
      '<assistant>\nChecking.\n<tool_call name="lookup" id="toolu_1">{"item":"7"}</tool_call>\n</assistant>'
    )
    // A new session holds no call for a result to answer: the result is part of the transcript.
    expect(transcript?.text).toContain(
      '<tool_result name="lookup" id="toolu_1" error="true">lookup failed</tool_result>'
    )
    expect(transcript?.text).not.toContain("Not replayed.")
    expect(continuation).toEqual({ type: "text", text: "Continue from the tool results above." })
  })

  test("joins every system message into the system prompt", () => {
    const turn = planTurn([system, user("Hi"), { role: "system", content: "Notice." }])

    expect(turn.systemPrompt).toBe("Be terse.\n\nNotice.")
  })

  test("rejects a conversation that ends with an answer", () => {
    expect(() =>
      planTurn([user("Hi"), { role: "assistant", content: [{ type: "text", text: "Hello." }] }])
    ).toThrow("must end with a user message or tool results")
  })
})
