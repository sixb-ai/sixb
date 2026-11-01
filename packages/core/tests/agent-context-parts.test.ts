import { describe, expect, test } from "bun:test"
import { AGENT_IMAGE_INPUT_TOKENS, measureAgentStepRequest } from "../src/agents"
import { measureAgentContextHistory } from "../src/agents/context-compaction"
import { apportionAgentContextTokens } from "../src/agents/context-parts"
import type { AgentMessage } from "../src/agents/message"
import { projectAgentThreadModelContext } from "../src/agents/thread-context-projection"
import type { ModelMessage } from "../src/models"
import type { AgentContextCheckpointRecord, AgentMessageRecord } from "../src/storage/agents"

// What a context meter splits a request into: each step records the parts it sent, and the meter
// splits what the next request weighs by the same parts.

const bytes = (text: string) => new TextEncoder().encode(text).byteLength
const CONTEXT = ".sixb/agent"

/** An assistant that read `path` with `toolName`, and the tool's answer. */
function readCall(toolCallId: string, toolName: string, path: string, output: string) {
  return [
    {
      role: "assistant",
      content: [{ type: "tool-call", toolCallId, toolName, input: { path } }],
    },
    {
      role: "tool",
      content: [
        { type: "tool-result", toolCallId, toolName, output: { type: "text", value: output } },
      ],
    },
  ] satisfies ModelMessage[]
}

describe("measureAgentStepRequest", () => {
  test("splits the prompt by the sections it was rendered with, and counts the tools as sent", () => {
    const prompt =
      "<rules>Be brief.</rules>\n\n<agent_instructions>\nUse euros.\n</agent_instructions>"
    const instructions = bytes("<agent_instructions>\nUse euros.\n</agent_instructions>")
    const tool = { name: "read", description: "Read a file.", inputSchema: { type: "object" } }

    const request = measureAgentStepRequest({
      messages: [
        { role: "system", content: prompt },
        { role: "user", content: [{ type: "text", text: "Hello" }] },
      ],
      tools: [tool],
      systemPrompt: {
        text: prompt,
        bytes: { system: bytes(prompt) - instructions, instructions },
      },
    })

    expect(request).toEqual({
      system: { system: bytes(prompt) - instructions, instructions },
      tools: { count: 1, bytes: bytes("read" + "Read a file." + '{"type":"object"}') },
      history: { messages: bytes("Hello") },
    })

    // A prompt it was not rendered with, as after a compaction it did not render, is Sixb's own.
    // Removal proof: use the sections whatever the system text; this request names instructions
    // its prompt does not carry.
    const other = measureAgentStepRequest({
      messages: [{ role: "system", content: "Another prompt." }],
      tools: [],
      systemPrompt: { text: prompt, bytes: { system: 1, instructions: 2 } },
    })
    expect(other.system).toEqual({ system: bytes("Another prompt.") })
  })

  // Removal proof: drop the `$SIXB_*_DIR` match from agentContextFileKind, or its match of an
  // absolute path that spells out a relative context directory; a read falls into tool results.
  test("names the summary, attachments and images, and a read of memory, a skill or the ontology", () => {
    const [checkpointSummary] = projectAgentThreadModelContext({
      checkpoint: checkpoint(),
      messages: [record(2, "user", "Go on.")],
    })
    const summaryText = (checkpointSummary?.parts[0] as { text: string }).text

    const request = measureAgentStepRequest({
      contextDirectory: CONTEXT,
      tools: [],
      messages: [
        { role: "user", content: [{ type: "text", text: summaryText }] },
        {
          role: "user",
          content: [
            { type: "text", text: '<attachment name="q3.csv">\na,b\n</attachment>' },
            { type: "file", data: new URL("https://files.test/1"), mediaType: "image/png" },
            { type: "text", text: "Compare them." },
          ],
        },
        ...readCall("memory", "read", `${CONTEXT}/memory/user/MEMORY.md`, "- Prefers euros"),
        ...readCall("skill", "read", `${CONTEXT}/skills/charts/SKILL.md`, "# Charts"),
        ...readCall(
          "ontology",
          "view_file",
          `/workspace/${CONTEXT}/ontology/invoice.md`,
          "Invoice"
        ),
        ...readCall("variable", "read", "$SIXB_MEMORY_DIR/project/MEMORY.md", "- Fiscal year"),
        // A bash `cat` of the same file is a command's output, not a read.
        ...readCall("cat", "bash", `${CONTEXT}/memory/user/MEMORY.md`, "- Prefers euros"),
        ...readCall("elsewhere", "read", "src/memory/notes.md", "notes"),
      ],
    })

    const call = (toolName: string, path: string) =>
      bytes(toolName) + bytes(JSON.stringify({ path }))
    expect(request.history).toEqual({
      summary: bytes(summaryText),
      files: bytes('<attachment name="q3.csv">\na,b\n</attachment>'),
      messages:
        bytes("Compare them.") +
        call("read", `${CONTEXT}/memory/user/MEMORY.md`) +
        call("read", `${CONTEXT}/skills/charts/SKILL.md`) +
        call("view_file", `/workspace/${CONTEXT}/ontology/invoice.md`) +
        call("read", "$SIXB_MEMORY_DIR/project/MEMORY.md") +
        call("bash", `${CONTEXT}/memory/user/MEMORY.md`) +
        call("read", "src/memory/notes.md"),
      memory: bytes("- Prefers euros") + bytes("- Fiscal year"),
      skills: bytes("# Charts"),
      ontology: bytes("Invoice"),
      toolResults: bytes("- Prefers euros") + bytes("notes"),
    })
    expect(request.images).toBe(1)
  })
})

describe("measureAgentContextHistory", () => {
  // Removal proof: count every tool output as a tool result in context-compaction's
  // measureMessage; memory and the skill fall into tool results.
  test("splits a stored history as its requests send it: a read file counts as what it is", () => {
    const history: AgentMessage[] = [
      { role: "user", parts: [{ type: "text", text: "Chart the invoices." }] },
      {
        role: "assistant",
        parts: [
          { type: "step-start" },
          storedRead("memory", `${CONTEXT}/memory/user/MEMORY.md`, "- Prefers bars"),
          storedRead("skill", `${CONTEXT}/skills/charts/SKILL.md`, "# Charts"),
          storedRead("other", "data/invoices.csv", "a,b"),
          { type: "text", text: "Done." },
        ],
      },
    ]

    const size = measureAgentContextHistory({ messages: history, contextDirectory: CONTEXT })

    expect(size.parts).toMatchObject({
      memory: bytes(JSON.stringify("- Prefers bars")),
      skills: bytes(JSON.stringify("# Charts")),
      toolResults: bytes(JSON.stringify("a,b")),
    })
    // The split covers the whole measure.
    const parts = Object.values(size.parts).reduce((total, part) => total + (part ?? 0), 0)
    expect(parts).toBe(size.bytes)
  })
})

describe("apportionAgentContextTokens", () => {
  // Removal proof: scale every part to the total by its weight; the prompt then takes a share of
  // what dense tool results weigh past their bytes, and grows with each one after it.
  test("keeps the prompt at the model's typical rate, and gives the history the rest", () => {
    const parts = apportionAgentContextTokens({
      totalTokens: 30_001,
      prompt: { system: 16_000, tools: 8_000 },
      promptBytesPerToken: 4,
      // Dense output, which a thread measured at 2 bytes per token.
      history: { messages: 4_000, toolResults: 36_000 },
      images: 1,
      bytesPerToken: 2,
    })
    const share = (part: string) => parts.find((each) => each.part === part)?.tokens

    expect(parts.map(({ part }) => part)).toEqual([
      "system",
      "tools",
      "messages",
      "toolResults",
      "files",
    ])
    expect(share("system")).toBe(4_000)
    expect(share("tools")).toBe(2_000)
    expect(parts.reduce((total, { tokens }) => total + tokens, 0)).toBe(30_001)
    // The image weighs its own count against the messages' 2,000 tokens.
    expect(share("files")! / share("messages")!).toBeCloseTo(AGENT_IMAGE_INPUT_TOKENS / 2_000, 2)
  })

  test("scales a prompt that outweighs the total down to it, and splits nothing without sizes", () => {
    const prompt = apportionAgentContextTokens({
      totalTokens: 1_000,
      prompt: { system: 6_000, tools: 2_000 },
      promptBytesPerToken: 4,
      history: { messages: 400 },
      bytesPerToken: 4,
    })
    expect(prompt).toEqual([
      { part: "system", tokens: 750 },
      { part: "tools", tokens: 250 },
    ])

    const none = { prompt: {}, promptBytesPerToken: 4, history: {}, bytesPerToken: 4 }
    expect(apportionAgentContextTokens({ ...none, totalTokens: 100 })).toEqual([])
    expect(
      apportionAgentContextTokens({ ...none, totalTokens: 0, history: { messages: 10 } })
    ).toEqual([])
  })
})

function storedRead(toolCallId: string, path: string, output: string) {
  return {
    type: "tool-call" as const,
    toolCallId,
    toolName: "read",
    input: { path },
    state: "output-available" as const,
    output,
  }
}

function record(seq: number, role: AgentMessageRecord["role"], text: string): AgentMessageRecord {
  return {
    id: `message_${seq}`,
    projectId: "project",
    threadId: "thread",
    runId: role === "assistant" ? `run_${seq}` : null,
    role,
    seq,
    parts: [{ type: "text", text }],
    contentVersion: 1,
    createdAt: new Date(`2026-11-01T12:${String(seq).padStart(2, "0")}:00.000Z`),
  }
}

function checkpoint(): AgentContextCheckpointRecord {
  return {
    id: "checkpoint",
    projectId: "project",
    threadId: "thread",
    createdByRunId: "run_2",
    reason: "threshold",
    summary: "The user asked for a chart.",
    summaryFormatVersion: 1,
    summarizedThroughSeq: 1,
    observedHeadSeq: 2,
    estimatedInputTokensBefore: 1_000,
    estimatedInputTokensAfter: 200,
    summaryModelId: "model",
    createdAt: new Date("2026-11-01T12:00:00.000Z"),
  }
}
