import { describe, expect, test } from "bun:test"
import type { AgentDefinition } from "@sixb/core"
import { defineAgentTool } from "@sixb/core"
import type { AgentMessageRecord, AgentRunRecord } from "@sixb/core/storage"
import { combineAgentTools, resolveConversationToolProvision } from "../src/conversation-tools"
import type { AgentConversationToolProviderInput, AgentWorkerContext } from "../src/types"

const triggerMessage: AgentMessageRecord = {
  id: "message-1",
  projectId: "project-1",
  threadId: "thread-1",
  runId: null,
  role: "user",
  seq: 1,
  parts: [{ type: "text", text: "Open customers" }],
  contentVersion: 1,
  createdAt: new Date("2026-09-02T12:00:00.000Z"),
}

const agent = { id: "assistant", tools: [] } as unknown as AgentDefinition
const run = {
  id: "run-1",
  threadId: triggerMessage.threadId,
  triggerMessageId: triggerMessage.id,
} as unknown as AgentRunRecord

describe("conversation tool provisioning", () => {
  test("passes a cancellation signal and stops waiting when the turn aborts", async () => {
    const controller = new AbortController()
    let providerSignal: AbortSignal | undefined
    const context = {
      id: triggerMessage.projectId,
      conversationToolProvider: ({ signal }: AgentConversationToolProviderInput) => {
        providerSignal = signal
        return new Promise(() => {})
      },
    } as unknown as AgentWorkerContext

    const resolving = resolveConversationToolProvision({
      context,
      agent,
      run,
      messages: [triggerMessage],
      signal: controller.signal,
    })
    controller.abort(new Error("cancelled"))

    await expect(resolving).rejects.toThrow("cancelled")
    expect(providerSignal).toBe(controller.signal)
  })

  test("rejects duplicate names across declared and runtime tools", () => {
    const declared = defineAgentTool("open_record")
      .description("Open a record")
      .input({})
      .run(() => null)
    const runtime = defineAgentTool("open_record")
      .description("Open a runtime record")
      .input({})
      .run(() => null)

    expect(() => combineAgentTools([declared], [runtime])).toThrow(
      "Agent tools contain duplicate name 'open_record'"
    )
  })
})
