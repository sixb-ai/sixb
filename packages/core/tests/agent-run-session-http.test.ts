import { describe, expect, spyOn, test } from "bun:test"
import { InMemoryBlobStorage } from "../src"
import {
  type AgentRunSession,
  agentToolOutputPath,
  claimAgentRun,
  claimAgentRunForRunner,
  createHttpAgentRunSession,
  serveAgentRunSession,
} from "../src/agents"
import { createAgentRunnerToken } from "../src/agents/run-token"
import type { AgentRunRecord } from "../src/storage/agents"
import {
  type ClaimAgentRunSession,
  describeAgentRunSessionContract,
  seedAgentRun,
} from "./agent-run-session-contract"

// The session suite, run on a session a runner reaches over HTTP: claimed as a runner claims, each
// operation one request to the server's handler, with no network between them.

const claimOverHttp: ClaimAgentRunSession = async (host, input) => {
  const claimed =
    input.run.status === "running"
      ? await takeOver(host, input)
      : await claimAgentRunForRunner(host, input)
  if (!claimed) return null
  return createHttpAgentRunSession({
    apiUrl: "http://sixb.test",
    runnerToken: claimed.runnerToken,
    run: claimed.run,
    fetch: async (request) =>
      (await serveAgentRunSession(host, request)) ?? new Response(null, { status: 404 }),
  }) as AgentRunSession<typeof input.run & AgentRunRecord> as never
}

/**
 * A runner over HTTP claims only a queued run, so the suite takes a running one over in process,
 * as the lapsed-run sweep does. The sessions it fences are still reached over HTTP.
 */
async function takeOver(...args: Parameters<ClaimAgentRunSession>) {
  const [host] = args
  const session = await claimAgentRun(...args)
  if (!session) return null
  await session.close()
  const { run, executionToken } = session
  return {
    run,
    runnerToken: createAgentRunnerToken({
      projectId: host.projectId,
      runId: run.id,
      executionToken,
    }),
  }
}

describeAgentRunSessionContract(claimOverHttp)

describe("a runner's messages", () => {
  // Reproduce: return the part as it came from withSavedOutputChecked; the stored message then
  // names a path outside the context directory, which a later run writes the blob at.
  test("keep a call's saved output only at the path the harness gives it", async () => {
    const { host, storage, run } = await seedAgentRun()
    const session = await claimOverHttp(host, { run, leaseExpiresAt: "2099-01-01T00:00:00.000Z" })
    if (!session) throw new Error("Expected the run to be claimed.")
    const fileRef = await new InMemoryBlobStorage().put({
      body: new TextEncoder().encode("the whole log\n"),
      fileName: "log.txt",
      mediaType: "text/plain",
    })
    const sha256 = fileRef.digest.slice("sha256:".length)
    const call = (toolCallId: string, path: string) => ({
      type: "tool-call" as const,
      toolCallId,
      toolName: "bash",
      input: {},
      state: "output-available" as const,
      output: {},
      outputFile: { fileRef, path },
    })

    const warn = spyOn(console, "warn").mockImplementation(() => {})
    await session.finish({ status: "succeeded", finishReason: "stop" }, [
      {
        id: "message-work",
        projectId: run.projectId,
        threadId: run.threadId,
        runId: run.id,
        role: "assistant",
        parts: [
          call("kept", agentToolOutputPath("kept", sha256)),
          call("escaping", "../../../home/u/.bashrc"),
          call("other_content", agentToolOutputPath("other_content", "0".repeat(64))),
        ],
      },
    ])

    expect(warn).toHaveBeenCalledTimes(2)
    warn.mockRestore()

    const { messages } = await storage.agents.messages.list({
      projectId: run.projectId,
      threadId: run.threadId,
    })
    const parts = messages.find((message) => message.id === "message-work")?.parts ?? []
    expect(
      parts.map((part) =>
        part.type === "tool-call" && "outputFile" in part ? part.toolCallId : null
      )
    ).toEqual(["kept", null, null])
    session.close()
  })
})
