import { describe, expect, test } from "bun:test"
import { AgentRequestError } from "../src/agents/errors"
import {
  type AgentRunConversationStorage,
  agentRunConversation,
  agentRunConversationShared,
} from "../src/agents/participants"
import type { AgentRunRecord, AgentThreadRecord } from "../src/storage/agents"

const projectId = "agent-run-conversation"
const alice = { type: "user", id: "usr_alice" } as const

/** A child whose own thread is gone: its parent's run still says which conversation it serves. */
const child = {
  id: "run_child",
  projectId,
  kind: "subagent",
  threadId: "thr_child_gone",
  parentRunId: "run_parent",
  executionId: "exe_child",
} as AgentRunRecord

/** Storage holding the conversation `thr_1` of Alice's, the parent's run, and the child's execution. */
function storage(parentRun: boolean): AgentRunConversationStorage {
  const conversation = { id: "thr_1", kind: "conversation", ownerPrincipal: alice }
  return {
    agents: {
      threads: {
        getById: async ({ id }: { id: string }) =>
          id === "thr_1" ? (conversation as AgentThreadRecord) : null,
        listParticipants: async () => [],
      },
      runs: {
        getById: async ({ id }: { id: string }) =>
          parentRun && id === "run_parent"
            ? ({ id, kind: "conversation", threadId: "thr_1" } as AgentRunRecord)
            : null,
      },
    } as unknown as AgentRunConversationStorage["agents"],
    executions: {
      getById: async () => ({ requestedBy: alice }) as never,
    },
  }
}

describe("agentRunConversation", () => {
  // Guard proof: answer a child whose thread is gone with its own thread id; the conversation it
  // serves, `thr_1`, is no longer what a search leaves out.
  test("finds a sub-agent's conversation from its parent's run once its thread is gone", async () => {
    expect(await agentRunConversation(storage(true), child)).toEqual({
      threadId: "thr_1",
      shared: false,
    })
  })

  // Guard proof: answer with the child's own thread id when nothing says which conversation it
  // serves; nothing is refused, and the search excludes a thread that holds no turn.
  test("refuses a sub-agent whose conversation cannot be told, which counts as shared", async () => {
    const error = await agentRunConversation(storage(false), child).catch((caught) => caught)
    expect(error).toBeInstanceOf(AgentRequestError)
    expect((error as AgentRequestError).code).toBe("thread_not_found")

    expect(await agentRunConversationShared(storage(false), child)).toBe(true)
  })
})
