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
import { MockLanguageModel, streamFromArray } from "./helpers/models"

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
  // names a path outside the context directory, which a later run writes the blob at. Accept any
  // extension in TOOL_OUTPUT_PATH; the `.sh` file is then kept.
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
          call("page", agentToolOutputPath("page", sha256, "md")),
          call("escaping", "../../../home/u/.bashrc"),
          call("other_content", agentToolOutputPath("other_content", "0".repeat(64))),
          call("script", `tool-outputs/script-${sha256.slice(0, 12)}.sh`),
        ],
      },
    ])

    expect(warn).toHaveBeenCalledTimes(3)
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
    ).toEqual(["kept", "page", null, null, null])
    session.close()
  })
})

describe("a runner's models", () => {
  // Guard proof: return httpModel for every model in createHttpAgentRunSession's models.language;
  // the call then reaches the project's binding, which throws.
  test("call a model that runs on computers on the runner, and record it at the project", async () => {
    const { host, storage, run } = await seedAgentRun()
    const claimed = await claimAgentRunForRunner(host, {
      run,
      leaseExpiresAt: "2099-01-01T00:00:00.000Z",
    })
    if (!claimed) throw new Error("Expected the run to be claimed.")
    const asked: string[] = []
    const session = createHttpAgentRunSession({
      apiUrl: "http://sixb.test",
      runnerToken: claimed.runnerToken,
      run: claimed.run,
      fetch: async (request) =>
        (await serveAgentRunSession(host, request)) ?? new Response(null, { status: 404 }),
      localModel: (described) => {
        asked.push(described.modelId)
        return new MockLanguageModel({
          providerId: described.providerId,
          modelId: described.modelId,
          stream: async () =>
            streamFromArray([
              { type: "stream-start" },
              { type: "text-start", id: "text" },
              { type: "text-delta", id: "text", delta: "From this computer." },
              { type: "text-end", id: "text" },
              { type: "finish", finishReason: "stop", usage: { inputTokens: 9, outputTokens: 4 } },
            ]),
        })
      },
    })

    const model = await session.models.language({ provider: "test", modelId: "computer-model" })
    const stream = await model.stream({
      callId: "call-1",
      messages: [{ role: "user", content: [{ type: "text", text: "Hello" }] }],
      tools: [],
      signal: new AbortController().signal,
    })
    const text: string[] = []
    for await (const event of stream.events) {
      if (event.type === "text-delta") text.push(event.delta)
    }
    // A model the project calls itself stays the project's, whatever the runner offers.
    await session.models.language({ provider: "test", modelId: "test-model" })

    expect(text.join("")).toBe("From this computer.")
    expect(asked).toEqual(["computer-model"])
    const summary = await storage.aiUsage.summarizeExecution({
      projectId: run.projectId,
      executionId: run.executionId,
    })
    expect(summary).toMatchObject({ modelCallCount: 1, usage: { inputTokens: 9 } })
    session.close()
  })

  // Guard proof: pass `local` to computerModel unresolved, or drop the context it takes from it; the
  // runner's model then has no context window, and the Agent assumes one.
  test("size a computer model's context to what the runner's copy reports", async () => {
    const { host, run } = await seedAgentRun()
    const claimed = await claimAgentRunForRunner(host, {
      run,
      leaseExpiresAt: "2099-01-01T00:00:00.000Z",
    })
    if (!claimed) throw new Error("Expected the run to be claimed.")
    const session = createHttpAgentRunSession({
      apiUrl: "http://sixb.test",
      runnerToken: claimed.runnerToken,
      run: claimed.run,
      fetch: async (request) =>
        (await serveAgentRunSession(host, request)) ?? new Response(null, { status: 404 }),
      localModel: (described) => {
        const local = new MockLanguageModel({
          providerId: described.providerId,
          modelId: described.modelId,
        })
        // The window is known once the copy resolves, as Claude Code's is.
        const resolved = new MockLanguageModel({
          definition: { ...local.definition, contextWindow: 1_000_000 },
        })
        return Object.assign(local, { resolve: async () => resolved })
      },
    })

    const model = await session.models.language({ provider: "test", modelId: "computer-model" })

    expect(model.definition.contextWindow).toBe(1_000_000)
    session.close()
  })
})
