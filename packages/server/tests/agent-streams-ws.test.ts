import { describe, expect, test } from "bun:test"
import { createServer } from "node:net"
import {
  type AuthorizationContext,
  emptyGrantIndex,
  InMemoryBlobStorage,
  InMemoryBroker,
  InMemoryLakeStorage,
  InMemoryQueues,
  InMemoryStorage,
  type JsonValue,
  type OntologySource,
  type Principal,
  SixbHost,
  type SixbHostOptions,
} from "@sixb/core"
import {
  AGENT_RUN_STREAM_SCHEMA_VERSION,
  type AgentRunStreamEvent,
  agentRunStreamDefinition,
  agentRunStreamId,
} from "@sixb/core/agents/streams"
import { bindRequestExecution } from "@sixb/core/internal/request-execution"
import type { AgentStorage } from "@sixb/core/storage"
import { createTestAgentExecution } from "@sixb/core/testing"
import { canAccessAgentRunStream, parseAgentStreamMessage } from "../src/routes/ws/agents"
import { SixbServer } from "../src/server"
import { createTestBrowserPolicy } from "./helpers"

const projectId = "agent-ws-test-project"
const runId = "agt_run_ws_1"
const threadId = "thr_ws_1"
const agentId = "business-analyst"

describe("parseAgentStreamMessage", () => {
  test("accepts subscribe, replay, and unsubscribe messages", () => {
    expect(parseAgentStreamMessage({ type: "subscribe", runId, afterCursor: "1" })).toEqual({
      ok: true,
      data: { type: "subscribe", runId, afterCursor: "1" },
    })
    expect(parseAgentStreamMessage({ type: "replay", runId, limit: 25 })).toEqual({
      ok: true,
      data: { type: "replay", runId, limit: 25 },
    })
    expect(parseAgentStreamMessage({ type: "unsubscribe", runId })).toEqual({
      ok: true,
      data: { type: "unsubscribe", runId },
    })
  })

  test("rejects non-object and invalid messages", () => {
    expect(parseAgentStreamMessage("subscribe")).toEqual({
      ok: false,
      error: "Message must be a JSON object.",
    })
    expect(parseAgentStreamMessage({ type: "subscribe" }).ok).toBe(false)
    expect(parseAgentStreamMessage({ type: "replay", runId, limit: 0 }).ok).toBe(false)
  })
})

describe("/ws/agents", () => {
  test("replays retained records, streams live records, and unsubscribes", async () => {
    await withAgentWsServer(async ({ baseUrl, sixb }) => {
      const [started] = await appendAgentStreamRecord(sixb, {
        type: "agent.run.started",
        runId,
      })
      const ws = new WebSocket(`${baseUrl.replace("http://", "ws://")}/ws/agents`)

      try {
        expect(await nextWsMessage(ws)).toEqual({ type: "connected", channel: "agents" })
        ws.send(JSON.stringify({ type: "subscribe", runId }))

        expect(await nextWsMessage(ws)).toEqual({
          type: "subscribed",
          runId,
          afterCursor: null,
        })
        expect(await nextWsMessage(ws)).toMatchObject({
          type: "record",
          record: { cursor: started?.cursor, name: "agent.run.started" },
        })
        expect(await nextWsMessage(ws)).toMatchObject({
          type: "run.snapshot",
          run: { id: runId, status: "running", attempt: 1 },
        })

        const [chunk] = await appendAgentStreamRecord(sixb, {
          type: "agent.ui.chunk",
          runId,
          chunkIndex: 0,
        })
        expect(await nextWsMessage(ws)).toMatchObject({
          type: "record",
          record: { cursor: chunk?.cursor, name: "agent.ui.chunk" },
        })

        ws.send(JSON.stringify({ type: "unsubscribe" }))
        expect(await nextWsMessage(ws)).toEqual({ type: "unsubscribed", runId })

        await appendAgentStreamRecord(sixb, { type: "agent.run.finished", runId })
        await expectNoWsMessage(ws)
      } finally {
        ws.close()
      }
    })
  })

  test("streams a durable queued snapshot before the worker starts", async () => {
    await withAgentWsServer(async ({ baseUrl, sixb }) => {
      const agents = agentStorage(sixb)
      await agents.threads.create({
        id: threadId,
        projectId,
        agentId,
        ownerPrincipal: { type: "system", id: "system" },
      })
      const executionId = await createTestAgentExecution(sixb.storage, {
        projectId,
        agentId,
        runId,
      })
      await agents.runs.create({
        id: runId,
        projectId,
        executionId,
        threadId,
        agentId,
        triggerMessageId: "msg_queued",
      })
      const ws = new WebSocket(`${baseUrl.replace("http://", "ws://")}/ws/agents`)

      try {
        expect(await nextWsMessage(ws)).toEqual({ type: "connected", channel: "agents" })
        ws.send(JSON.stringify({ type: "subscribe", runId }))
        expect(await nextWsMessage(ws)).toEqual({
          type: "subscribed",
          runId,
          afterCursor: null,
        })
        expect(await nextWsMessage(ws)).toMatchObject({
          type: "run.snapshot",
          run: { id: runId, status: "queued", attempt: 0 },
        })
        await expectNoWsMessage(ws)
      } finally {
        ws.close()
      }
    })
  })

  test("replays records without creating a live subscription", async () => {
    await withAgentWsServer(async ({ baseUrl, sixb }) => {
      const [started] = await appendAgentStreamRecord(sixb, {
        type: "agent.run.started",
        runId: "agt_run_ws_replay",
      })
      const ws = new WebSocket(`${baseUrl.replace("http://", "ws://")}/ws/agents`)

      try {
        expect(await nextWsMessage(ws)).toEqual({ type: "connected", channel: "agents" })
        ws.send(JSON.stringify({ type: "replay", runId: "agt_run_ws_replay" }))

        expect(await nextWsMessage(ws)).toMatchObject({
          type: "record",
          record: { cursor: started?.cursor, name: "agent.run.started" },
        })
        expect(await nextWsMessage(ws)).toEqual({
          type: "replayed",
          runId: "agt_run_ws_replay",
          afterCursor: started?.cursor,
          count: 1,
        })
        expect(await nextWsMessage(ws)).toMatchObject({
          type: "run.snapshot",
          run: { id: "agt_run_ws_replay", status: "running", attempt: 1 },
        })

        await appendAgentStreamRecord(sixb, {
          type: "agent.run.finished",
          runId: "agt_run_ws_replay",
        })
        await expectNoWsMessage(ws)
      } finally {
        ws.close()
      }
    })
  })

  test("resumes from an afterCursor", async () => {
    await withAgentWsServer(async ({ baseUrl, sixb }) => {
      const [started] = await appendAgentStreamRecord(sixb, {
        type: "agent.run.started",
        runId: "agt_run_ws_cursor",
      })
      const [finished] = await appendAgentStreamRecord(sixb, {
        type: "agent.run.finished",
        runId: "agt_run_ws_cursor",
      })
      const ws = new WebSocket(`${baseUrl.replace("http://", "ws://")}/ws/agents`)

      try {
        expect(await nextWsMessage(ws)).toEqual({ type: "connected", channel: "agents" })
        ws.send(
          JSON.stringify({
            type: "subscribe",
            runId: "agt_run_ws_cursor",
            afterCursor: started?.cursor,
          })
        )

        expect(await nextWsMessage(ws)).toEqual({
          type: "subscribed",
          runId: "agt_run_ws_cursor",
          afterCursor: started?.cursor,
        })
        expect(await nextWsMessage(ws)).toMatchObject({
          type: "record",
          record: { cursor: finished?.cursor, name: "agent.run.finished" },
        })
        expect(await nextWsMessage(ws)).toMatchObject({
          type: "run.snapshot",
          run: { id: "agt_run_ws_cursor", status: "succeeded", attempt: 1 },
        })
      } finally {
        ws.close()
      }
    })
  })

  test("requires authentication when auth is enabled", async () => {
    await withAgentWsServer({ auth: true }, async ({ baseUrl }) => {
      await expectWebSocketRejected(`${baseUrl.replace("http://", "ws://")}/ws/agents`)
    })
  })
})

describe("canAccessAgentRunStream", () => {
  test("allows owners and rejects other authenticated principals", async () => {
    const sixb = createSixbInstance<readonly OntologySource[]>({
      id: projectId,
      ontology: [],
      broker: new InMemoryBroker(),
      storage: new InMemoryStorage(),
      lakeStorage: new InMemoryLakeStorage(),
      blobStorage: new InMemoryBlobStorage(),
      queues: new InMemoryQueues(),
      auth: { id: "test", kind: "dev" },
    })
    const owner: Principal = { type: "user", id: "usr_owner" }
    const agents = agentStorage(sixb)
    await agents.threads.create({
      id: threadId,
      projectId,
      agentId,
      ownerPrincipal: owner,
    })
    const executionId = await createTestAgentExecution(sixb.storage, {
      projectId,
      agentId,
      runId,
    })
    await agents.runs.create({
      id: runId,
      projectId,
      executionId,
      threadId,
      agentId,
      triggerMessageId: "msg_ws_1",
    })

    await expect(
      canAccessAgentRunStream(requestSdk(sixb, authz(owner, [agentId])), runId)
    ).resolves.toEqual({
      ok: true,
    })
    await expect(canAccessAgentRunStream(requestSdk(sixb, authz(owner)), runId)).resolves.toEqual({
      ok: false,
      message: "Agent run not found.",
    })
    await expect(
      canAccessAgentRunStream(
        requestSdk(sixb, authz({ type: "user", id: "usr_other" }, [agentId])),
        runId
      )
    ).resolves.toEqual({ ok: false, message: "Agent run not found." })
  })

  test("rejects unknown run ids instead of authorizing them through a supplied thread", async () => {
    const sixb = createSixbInstance<readonly OntologySource[]>({
      id: projectId,
      ontology: [],
      broker: new InMemoryBroker(),
      storage: new InMemoryStorage(),
      lakeStorage: new InMemoryLakeStorage(),
      blobStorage: new InMemoryBlobStorage(),
      queues: new InMemoryQueues(),
      auth: { id: "test", kind: "dev" },
    })
    const owner: Principal = { type: "user", id: "usr_owner" }
    await agentStorage(sixb).threads.create({
      id: threadId,
      projectId,
      agentId,
      ownerPrincipal: owner,
    })

    await expect(
      canAccessAgentRunStream(requestSdk(sixb, authz(owner, [agentId])), "agt_run_missing")
    ).resolves.toEqual({ ok: false, message: "Agent run not found." })
  })
})

function requestSdk(
  sixb: SixbHost<readonly OntologySource[]>,
  authorization: AuthorizationContext
) {
  return bindRequestExecution(sixb, {
    request: new Request("http://localhost/ws/agents", {
      headers: { "x-request-id": "req_agent_stream_test" },
    }),
    authorization: { type: "principal", context: authorization },
  })
}

function createSixbInstance<TOntologySources extends readonly OntologySource[]>(
  options: SixbHostOptions<TOntologySources>
): SixbHost<TOntologySources> {
  return new SixbHost<TOntologySources>(options)
}

async function withAgentWsServer(
  run: (context: { baseUrl: string; sixb: SixbHost<readonly OntologySource[]> }) => Promise<void>
): Promise<void>
async function withAgentWsServer(
  options: { readonly auth?: boolean },
  run: (context: { baseUrl: string; sixb: SixbHost<readonly OntologySource[]> }) => Promise<void>
): Promise<void>
async function withAgentWsServer(
  optionsOrRun:
    | { readonly auth?: boolean }
    | ((context: { baseUrl: string; sixb: SixbHost<readonly OntologySource[]> }) => Promise<void>),
  maybeRun?: (context: {
    baseUrl: string
    sixb: SixbHost<readonly OntologySource[]>
  }) => Promise<void>
): Promise<void> {
  const options = typeof optionsOrRun === "function" ? {} : optionsOrRun
  const run = typeof optionsOrRun === "function" ? optionsOrRun : maybeRun
  if (!run) {
    throw new Error("withAgentWsServer requires a run callback")
  }

  const port = await getFreePort()
  const baseUrl = `http://127.0.0.1:${port}`
  const sixb = createSixbInstance<readonly OntologySource[]>({
    id: projectId,
    ontology: [],
    broker: new InMemoryBroker(),
    storage: new InMemoryStorage(),
    lakeStorage: new InMemoryLakeStorage(),
    blobStorage: new InMemoryBlobStorage(),
    queues: new InMemoryQueues(),
    ...(options.auth ? { auth: { id: "test", kind: "dev" as const } } : {}),
  })
  const server = new SixbServer({
    host: sixb,
    hostname: "127.0.0.1",
    port,
    quiet: true,
    browser: createTestBrowserPolicy({ apiOrigin: baseUrl, atlasOrigin: baseUrl }),
  })

  await server.start()
  try {
    await run({ baseUrl, sixb })
  } finally {
    await server.stop()
  }
}

async function appendAgentStreamRecord(
  sixb: SixbHost<readonly OntologySource[]>,
  input:
    | { readonly type: "agent.run.started"; readonly runId: string }
    | { readonly type: "agent.ui.chunk"; readonly runId: string; readonly chunkIndex: number }
    | { readonly type: "agent.run.finished"; readonly runId: string }
) {
  await advanceDurableRun(sixb, input)
  await sixb.broker.ensureStream({
    projectId: sixb.id,
    stream: agentRunStreamDefinition(input.runId),
  })

  const payload = agentStreamPayload(input)
  return sixb.broker.append({
    projectId: sixb.id,
    streamId: agentRunStreamId(input.runId),
    records: [
      {
        name: payload.type,
        key: input.runId,
        payload: payload as unknown as JsonValue,
      },
    ],
  })
}

async function advanceDurableRun(
  sixb: SixbHost<readonly OntologySource[]>,
  input:
    | { readonly type: "agent.run.started"; readonly runId: string }
    | { readonly type: "agent.ui.chunk"; readonly runId: string; readonly chunkIndex: number }
    | { readonly type: "agent.run.finished"; readonly runId: string }
): Promise<void> {
  const agents = agentStorage(sixb)
  const existingThread = await agents.threads.getById({ projectId, id: threadId })
  if (!existingThread) {
    await agents.threads.create({
      id: threadId,
      projectId,
      agentId,
      ownerPrincipal: { type: "system", id: "system" },
    })
  }

  let run = await agents.runs.getById({ projectId, id: input.runId })
  const executionToken = `exec_${input.runId}`
  if (!run) {
    const executionId = await createTestAgentExecution(sixb.storage, {
      projectId,
      agentId,
      runId: input.runId,
    })
    run = await agents.runs.create({
      id: input.runId,
      projectId,
      executionId,
      threadId,
      agentId,
      triggerMessageId: `msg_${input.runId}`,
    })
  }
  if (run.status === "queued") {
    run = await agents.runs.start({
      id: run.id,
      projectId,
      execution: {
        token: executionToken,
        queueLeaseExpiresAt: new Date(Date.now() + 60_000),
      },
      modelId: "test-model",
    })
  }
  if (input.type === "agent.run.finished" && run.status === "running") {
    await agents.runs.finish({
      id: run.id,
      projectId,
      executionToken,
      status: "succeeded",
      finishReason: "stop",
    })
  }
}

function agentStreamPayload(
  input:
    | { readonly type: "agent.run.started"; readonly runId: string }
    | { readonly type: "agent.ui.chunk"; readonly runId: string; readonly chunkIndex: number }
    | { readonly type: "agent.run.finished"; readonly runId: string }
): AgentRunStreamEvent {
  const base = {
    schemaVersion: AGENT_RUN_STREAM_SCHEMA_VERSION,
    projectId,
    runId: input.runId,
    threadId,
    agentId,
    attempt: 1,
    occurredAt: "2026-06-27T16:00:00.000Z",
  }

  switch (input.type) {
    case "agent.run.started":
      return { ...base, type: "agent.run.started", modelId: "test-model" }
    case "agent.ui.chunk":
      return {
        ...base,
        type: "agent.ui.chunk",
        chunkIndex: input.chunkIndex,
        chunk: { type: "text-delta", textDelta: "hello" },
      }
    case "agent.run.finished":
      return { ...base, type: "agent.run.finished", status: "succeeded", finishReason: "stop" }
  }
}

async function getFreePort(): Promise<number> {
  return await new Promise<number>((resolvePromise, reject) => {
    const server = createServer() as ReturnType<typeof createServer> & {
      on(event: string, listener: (error: Error) => void): void
    }
    server.on("error", reject)
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      if (!address || typeof address === "string") {
        reject(new Error("Could not resolve an open port"))
        return
      }

      server.close((error) => {
        if (error) reject(error)
        else resolvePromise(address.port)
      })
    })
  })
}

async function nextWsMessage(ws: WebSocket, timeoutMs = 3000): Promise<Record<string, unknown>> {
  return await new Promise<Record<string, unknown>>((resolvePromise, reject) => {
    const timeout = setTimeout(() => {
      cleanup()
      reject(new Error("Timed out waiting for websocket message"))
    }, timeoutMs)

    const onMessage = (event: MessageEvent) => {
      cleanup()
      try {
        resolvePromise(JSON.parse(decodeWsData(event.data)) as Record<string, unknown>)
      } catch (error) {
        reject(error)
      }
    }
    const onError = () => {
      cleanup()
      reject(new Error("WebSocket error"))
    }
    const cleanup = () => {
      clearTimeout(timeout)
      ws.removeEventListener("message", onMessage)
      ws.removeEventListener("error", onError)
    }

    ws.addEventListener("message", onMessage)
    ws.addEventListener("error", onError)
  })
}

async function expectNoWsMessage(ws: WebSocket): Promise<void> {
  await new Promise<void>((resolvePromise, reject) => {
    const timeout = setTimeout(() => {
      cleanup()
      resolvePromise()
    }, 650)

    const onMessage = (event: MessageEvent) => {
      cleanup()
      reject(new Error(`Unexpected websocket message: ${decodeWsData(event.data)}`))
    }
    const onError = () => {
      cleanup()
      reject(new Error("WebSocket error"))
    }
    const cleanup = () => {
      clearTimeout(timeout)
      ws.removeEventListener("message", onMessage)
      ws.removeEventListener("error", onError)
    }

    ws.addEventListener("message", onMessage)
    ws.addEventListener("error", onError)
  })
}

async function expectWebSocketRejected(url: string): Promise<void> {
  await new Promise<void>((resolvePromise, reject) => {
    const ws = new WebSocket(url)
    const timeout = setTimeout(() => {
      cleanup()
      ws.close()
      reject(new Error("Timed out waiting for websocket rejection"))
    }, 3000)

    const onMessage = (event: MessageEvent) => {
      cleanup()
      ws.close()
      reject(new Error(`Unexpected websocket message: ${decodeWsData(event.data)}`))
    }
    const onOpen = () => {
      // A denied upgrade may still emit close after open depending on the runtime.
    }
    const onClose = () => {
      cleanup()
      resolvePromise()
    }
    const onError = () => {
      cleanup()
      resolvePromise()
    }
    const cleanup = () => {
      clearTimeout(timeout)
      ws.removeEventListener("message", onMessage)
      ws.removeEventListener("open", onOpen)
      ws.removeEventListener("close", onClose)
      ws.removeEventListener("error", onError)
    }

    ws.addEventListener("message", onMessage)
    ws.addEventListener("open", onOpen)
    ws.addEventListener("close", onClose)
    ws.addEventListener("error", onError)
  })
}

function decodeWsData(value: unknown): string {
  if (typeof value === "string") {
    return value
  }

  if (value instanceof ArrayBuffer) {
    return new TextDecoder().decode(value)
  }

  return String(value)
}

function authz(principal: Principal, agentIds: readonly string[] = []): AuthorizationContext {
  return {
    principal,
    groupIds: [],
    roleIds: [],
    grants: { ...emptyGrantIndex(), "run:agent": new Set(agentIds) },
  }
}

function agentStorage(sixb: SixbHost<readonly OntologySource[]>): AgentStorage {
  if (!sixb.storage.agents) {
    throw new Error("Expected test Sixb instance to include agent storage")
  }

  return sixb.storage.agents
}
