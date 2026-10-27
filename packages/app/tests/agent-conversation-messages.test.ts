import { describe, expect, test } from "bun:test"
import {
  type ConversationMessagesInput,
  conversationMessages,
  normalizedParts,
  type PendingUserMessage,
} from "../src/agent/conversation"
import { createLiveRunState, type LiveRunState } from "../src/agent/live-run"
import type { AgentMessage, AgentRun, AgentThread } from "../src/agent/types"

const at = "2026-10-27T09:00:00.000Z"
const alice = { type: "user", id: "usr_alice" } as const
const bob = { type: "user", id: "usr_bob" } as const

function saved(overrides: Partial<AgentMessage> & Pick<AgentMessage, "id" | "role">): AgentMessage {
  return {
    projectId: "proj",
    threadId: "thr_1",
    runId: null,
    seq: 1,
    parts: [],
    annotations: [],
    contentVersion: 1,
    createdAt: at,
    ...overrides,
  }
}

const question = saved({
  id: "msg_question",
  role: "user",
  authorPrincipal: bob,
  parts: [{ type: "text", text: "Which deals slipped?" }],
})

const answer = saved({
  id: "msg_answer",
  role: "assistant",
  runId: "run_1",
  seq: 2,
  parts: [{ type: "text", text: "Three deals slipped." }],
})

const pending: PendingUserMessage = {
  key: "sent:1",
  threadId: "thr_1",
  text: "Which deals slipped?",
  attachments: [],
  context: [],
  messageId: null,
}

function live(overrides: Partial<LiveRunState> = {}): LiveRunState {
  return {
    ...createLiveRunState("run_1"),
    active: true,
    parts: [{ kind: "text", text: "Three deals" }],
    partKeys: ["text#1#t"],
    ...overrides,
  }
}

function merge(input: Partial<ConversationMessagesInput>) {
  return conversationMessages({ messages: [], presentation: { kind: "idle" }, ...input })
}

const keys = (input: Partial<ConversationMessagesInput>) =>
  merge(input).map((message) => message.key)

describe("the conversation's messages", () => {
  test("a message the reader sends keeps its key once it is saved", () => {
    // Removal proof: drop the `sentKeys` lookup in savedKey; the saved copy reads message:<id>.
    expect(merge({ pending })).toMatchObject([
      { key: "sent:1", id: null, role: "user", status: "pending" },
    ])

    // The API accepted it: the pending copy stands until the saved one is read.
    const accepted = { ...pending, messageId: question.id }
    const sentKeys = new Map([[question.id, pending.key]])
    expect(keys({ pending: accepted, sentKeys })).toEqual(["sent:1"])

    const both = merge({ messages: [question], pending: accepted, sentKeys })
    expect(both).toMatchObject([{ key: "sent:1", id: question.id, status: "complete" }])

    // Reloaded, nothing remembers the pending copy.
    expect(keys({ messages: [question] })).toEqual([`message:${question.id}`])
  })

  test("a reply keeps its run's key from its stream to its saved copy, never shown twice", () => {
    // Removal proof: drop the answeredRuns check in liveReply; the run's key shows twice.
    const streaming = merge({ messages: [question], live: live() })
    expect(streaming.at(-1)).toMatchObject({
      key: "run:run_1",
      id: null,
      role: "assistant",
      status: "streaming",
      runId: "run_1",
    })

    // Saved, not read back yet: the stream stands for it, still drawn as live work.
    const finalized = live({
      active: false,
      finishStatus: "succeeded",
      finalizedMessageId: answer.id,
    })
    expect(merge({ messages: [question], live: finalized }).at(-1)).toMatchObject({
      key: "run:run_1",
      id: null,
      status: "streaming",
    })

    // Read back: one reply, the saved one, under the same key.
    const both = merge({ messages: [question, answer], live: finalized })
    expect(both.map((message) => [message.key, message.id])).toEqual([
      [`message:${question.id}`, question.id],
      ["run:run_1", answer.id],
    ])

    // A stream that missed its finalized event gives way to the saved reply of its run all the same.
    expect(keys({ messages: [question, answer], live: live() })).toEqual([
      `message:${question.id}`,
      "run:run_1",
    ])
  })

  test("an interrupted turn that saved nothing drops what it streamed", () => {
    const interrupted: AgentRun = {
      id: "run_1",
      projectId: "proj",
      kind: "conversation",
      threadId: "thr_1",
      triggerMessageId: question.id,
      attempt: 0,
      streamId: "stream_1",
      status: "cancelled",
      finishReason: "interrupted",
      createdAt: at,
    }
    const stopped = live({ active: false, finishStatus: "cancelled", finishReason: "interrupted" })

    expect(
      keys({
        messages: [question],
        live: stopped,
        presentation: { kind: "interrupted", run: interrupted, hasProgress: false },
      })
    ).toEqual([`message:${question.id}`])

    expect(
      merge({
        messages: [question],
        live: stopped,
        presentation: { kind: "interrupted", run: interrupted, hasProgress: true },
      }).at(-1)
    ).toMatchObject({ key: "run:run_1", status: "complete", unfinished: "cancelled" })
  })

  test("a saved reply whose run failed or was stopped says it did not finish", () => {
    // Removal proof: drop the `ended` lookup in conversationMessages; the saved reply of a failed run
    // reads as a finished answer once the thread is opened again.
    const run = (status: AgentRun["status"]): AgentRun => ({
      id: "run_1",
      projectId: "proj",
      kind: "conversation",
      threadId: "thr_1",
      triggerMessageId: question.id,
      attempt: 0,
      streamId: "stream_1",
      status,
      createdAt: at,
    })
    const reply = (status: AgentRun["status"]) =>
      merge({ messages: [question, answer], runs: [run(status)] }).at(-1)

    expect(reply("failed")).toMatchObject({ id: answer.id, unfinished: "failed" })
    expect(reply("cancelled")).toMatchObject({ id: answer.id, unfinished: "cancelled" })
    expect(reply("succeeded")?.unfinished).toBeUndefined()
    // The marked copy is kept, so a finished reply does not redraw on every render.
    const input = { messages: [question, answer], runs: [run("failed")] }
    expect(merge(input).at(-1)).toBe(merge(input).at(-1))
  })

  test("the message Continue writes for the model is not one", () => {
    // Removal proof: drop the isContinuation check in conversationMessages; an empty user message
    // shows between the answer and its continuation.
    const continuation = saved({
      id: "msg_continue",
      role: "user",
      authorPrincipal: bob,
      seq: 3,
      parts: [{ type: "continuation" }],
    })
    const continued = saved({ ...answer, id: "msg_continued", runId: "run_2", seq: 4 })

    expect(keys({ messages: [question, answer, continuation, continued] })).toEqual([
      `message:${question.id}`,
      "run:run_1",
      "run:run_2",
    ])
  })

  test("names each user message's author, the reader's own included", () => {
    const thread = {
      ownerPrincipal: alice,
      owner: { ...alice, displayName: "Alice Martin" },
      participants: [],
    } as unknown as AgentThread
    const fromAlice = saved({ ...question, id: "msg_alice", authorPrincipal: alice })
    const unknown = saved({ ...question, id: "msg_unknown", authorPrincipal: undefined })

    const messages = merge({
      messages: [question, fromAlice, unknown, answer],
      authors: [{ ...bob, displayName: "Bob Durand" }, alice],
      thread,
      reader: { ...bob, displayName: "Bob" },
      pending,
    })

    expect(messages.map((message) => message.author)).toEqual([
      { ...bob, displayName: "Bob Durand", isReader: true },
      // The thread's people name Alice, where the page's authors do not.
      { ...alice, displayName: "Alice Martin", isReader: false },
      undefined,
      undefined,
      { ...bob, displayName: "Bob Durand", isReader: true },
    ])

    // The reader nobody else names yet goes by their own account's name.
    expect(merge({ reader: { ...bob, displayName: "Bob" }, pending })[0]?.author).toEqual({
      ...bob,
      displayName: "Bob",
      isReader: true,
    })
  })

  test("parts read as the chat draws them, without the model's own bookkeeping", () => {
    const fileRef = { blobId: "blob_1", digest: "sha256:1", sizeBytes: 3, fileName: "a.png" }
    const reply = saved({
      id: "msg_parts",
      role: "assistant",
      runId: "run_2",
      parts: [
        { type: "step-start" },
        { type: "text", text: "Before " },
        { type: "provider-state", providerId: "p", data: null },
        { type: "text", text: "the tool." },
        {
          type: "tool-call",
          toolCallId: "call_1",
          toolName: "lookup",
          state: "output-available",
          input: { id: 1 },
          output: { ok: true },
        },
        { type: "step-start" },
        { type: "text", text: "Step two." },
        { type: "step-start" },
        { type: "text", text: "Step three." },
        { type: "file", fileRef },
      ],
    })

    const [message] = merge({ messages: [reply] })
    expect(message?.parts).toEqual([
      { type: "text", text: "Before the tool.", streaming: false },
      {
        type: "tool",
        toolName: "lookup",
        toolCallId: "call_1",
        state: "output-available",
        input: { id: 1 },
        output: { ok: true },
      },
      { type: "text", text: "Step two.", streaming: false },
      { type: "text", text: "Step three.", streaming: false },
      { type: "file", fileRef, source: expect.objectContaining({ name: "a.png" }) },
    ])

    // Two steps of text stay two paragraphs when the chat draws them.
    // Removal proof: drop the step boundary normalizedParts puts between texts; they join.
    expect(normalizedParts(message?.parts ?? []).map((part) => part.kind)).toEqual([
      "text",
      "tool",
      "text",
      "step-start",
      "text",
      "file",
    ])
  })

  test("a live reply joins its streamed text and names its tool calls", () => {
    const streaming = live({
      parts: [
        { kind: "text", text: "Looking " },
        { kind: "text", text: "it up." },
        { kind: "reasoning", text: "Which table?", streaming: true },
        { kind: "tool", tool: { toolName: "lookup", state: "input-streaming", inputText: "{" } },
        { kind: "text", text: "Found" },
      ],
      partKeys: ["text#1#a", "text#2#a", "reasoning#2#r", "tool#call_9", "text#3#b"],
    })

    expect(merge({ live: streaming })[0]?.parts).toEqual([
      { type: "text", text: "Looking it up.", streaming: false },
      { type: "reasoning", text: "Which table?", streaming: true },
      {
        type: "tool",
        toolName: "lookup",
        toolCallId: "call_9",
        state: "input-streaming",
        inputText: "{",
      },
      { type: "text", text: "Found", streaming: true },
    ])
  })

  test("an observer reads saved files through the observer's routes, with nothing live", () => {
    const fileRef = { blobId: "blob_1", digest: "sha256:1", sizeBytes: 3 }
    const withFile = saved({ ...question, parts: [{ type: "file", fileRef }] })

    const [own] = merge({ messages: [withFile] })
    const [observed] = merge({ messages: [withFile], observed: true })
    const url = (message: typeof own) =>
      message?.parts[0]?.type === "file" ? message.parts[0].source?.inlineUrl : undefined

    expect(url(own)).toContain("/api/agent-threads/thr_1/messages/msg_question/files/content")
    expect(url(observed)).toContain(
      "/api/observed-agent-threads/thr_1/messages/msg_question/files/content"
    )
    expect(merge({ messages: [withFile, answer], observed: true }).map((m) => m.status)).toEqual([
      "complete",
      "complete",
    ])
  })

  test("a saved message keeps its identity while the reply streams below it", () => {
    // Rows draw each saved message once: a chunk must not hand them a new object.
    const first = merge({ messages: [question, answer], live: live({ runId: "run_2" }) })
    const next = merge({
      messages: [question, answer],
      live: live({ runId: "run_2", parts: [{ kind: "text", text: "More" }] }),
    })

    expect(next[0]).toBe(first[0])
    expect(next[1]).toBe(first[1])
    expect(next[2]).not.toBe(first[2])
  })
})
