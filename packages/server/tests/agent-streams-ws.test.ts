import { describe, expect, test } from "bun:test"
import { createServer } from "node:net"
import {
  AGENT_RUN_STREAM_SCHEMA_VERSION,
  type AgentRunStreamEvent,
  type AgentStorage,
  type AuthorizationContext,
  agentRunStreamDefinition,
  agentRunStreamId,
  InMemoryBlobStorage,
  InMemoryBroker,
  InMemoryLakeStorage,
  InMemoryQueues,
  InMemoryStorage,
  type JsonValue,
  type OntologySource,
  type Principal,
  Sixb,
  type SixbOptions,
} from "@sixb/core"
import { canAccessAgentRunStream, parseAgentStreamMessage } from "../src/routes/ws/agents"
import { SixbServer } from "../src/server"
import { createTestBrowserPolicy } from "./helpers"

const projectId = "agent-ws-test-project"
const runId = "agt_run_ws_1"
const threadId = "thr_ws_1"
const agentId = "business-analyst"

describe("parseAgentStreamMessage", () => {
  test("accepts subscribe, replay, and unsubscribe messages", () => {
    expect(
      parseAgentStreamMessage({ type: "subscribe", runId, threadId, afterCursor: "1" })
    ).toEqual({
      ok: true,
      data: { type: "subscribe", runId, threadId, afterCursor: "1" },
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
    await agents.runs.reserve({
      id: runId,
      projectId,
      threadId,
      agentId,
      triggerMessageId: "msg_ws_1",
      requestedByPrincipal: owner,
      lease: { id: "lease_ws_1", expiresAt: new Date("2099-01-01T00:00:00.000Z") },
    })

    await expect(
      canAccessAgentRunStream(sixb, { runId, authz: authz(owner, [agentId]) })
    ).resolves.toEqual({
      ok: true,
    })
    await expect(canAccessAgentRunStream(sixb, { runId, authz: authz(owner) })).resolves.toEqual({
      ok: false,
      message: "Agent run not found.",
    })
    await expect(
      canAccessAgentRunStream(sixb, {
        runId,
        authz: authz({ type: "user", id: "usr_other" }, [agentId]),
      })
    ).resolves.toEqual({ ok: false, message: "Agent run not found." })
  })

  test("allows pre-claim subscriptions when the thread is owned and runnable", async () => {
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

    await expect(
      canAccessAgentRunStream(sixb, {
        runId: "agt_run_not_reserved",
        threadId,
        authz: authz(owner, [agentId]),
      })
    ).resolves.toEqual({ ok: true })
    await expect(
      canAccessAgentRunStream(sixb, {
        runId: "agt_run_not_reserved",
        threadId,
        authz: authz(owner),
      })
    ).resolves.toEqual({ ok: false, message: "Agent run not found." })
  })

  test("rejects pre-claim subscriptions that cannot be resolved or owned", async () => {
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
    await agents.threads.create({ id: threadId, projectId, agentId, ownerPrincipal: owner })

    // No run reserved and no threadId supplied: the caller must include one to subscribe early.
    await expect(
      canAccessAgentRunStream(sixb, {
        runId: "agt_run_not_reserved",
        authz: authz(owner, [agentId]),
      })
    ).resolves.toEqual({
      ok: false,
      message: "Agent run not found. Include threadId when subscribing before the run starts.",
    })

    // threadId points at a non-existent thread.
    await expect(
      canAccessAgentRunStream(sixb, {
        runId: "agt_run_not_reserved",
        threadId: "thr_missing",
        authz: authz(owner, [agentId]),
      })
    ).resolves.toEqual({ ok: false, message: "Agent run not found." })

    // threadId points at a thread owned by a different principal.
    await expect(
      canAccessAgentRunStream(sixb, {
        runId: "agt_run_not_reserved",
        threadId,
        authz: authz({ type: "user", id: "usr_other" }, [agentId]),
      })
    ).resolves.toEqual({ ok: false, message: "Agent run not found." })
  })
})

function createSixbInstance<TOntologySources extends readonly OntologySource[]>(
  options: SixbOptions<TOntologySources>
): Sixb<TOntologySources> {
  const SixbConstructor = Sixb as unknown as new (
    options: SixbOptions<TOntologySources>
  ) => Sixb<TOntologySources>

  return new SixbConstructor(options)
}

async function withAgentWsServer(
  run: (context: { baseUrl: string; sixb: Sixb<readonly OntologySource[]> }) => Promise<void>
): Promise<void>
async function withAgentWsServer(
  options: { readonly auth?: boolean },
  run: (context: { baseUrl: string; sixb: Sixb<readonly OntologySource[]> }) => Promise<void>
): Promise<void>
async function withAgentWsServer(
  optionsOrRun:
    | { readonly auth?: boolean }
    | ((context: { baseUrl: string; sixb: Sixb<readonly OntologySource[]> }) => Promise<void>),
  maybeRun?: (context: { baseUrl: string; sixb: Sixb<readonly OntologySource[]> }) => Promise<void>
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
    sixb,
    host: "127.0.0.1",
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
  sixb: Sixb<readonly OntologySource[]>,
  input:
    | { readonly type: "agent.run.started"; readonly runId: string }
    | { readonly type: "agent.ui.chunk"; readonly runId: string; readonly chunkIndex: number }
    | { readonly type: "agent.run.finished"; readonly runId: string }
) {
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
    grants: {
      "access:application": new Set(),
      "view:object": new Set(),
      "view:dataset": new Set(),
      "apply:action": new Set(),
      "run:workflow": new Set(),
      "run:sync": new Set(),
      "run:pipeline": new Set(),
      "run:agent": new Set(agentIds),
      "observe:logs": new Set(),
    },
  }
}

function agentStorage(sixb: Sixb<readonly OntologySource[]>): AgentStorage {
  if (!sixb.storage.agents) {
    throw new Error("Expected test Sixb instance to include agent storage")
  }

  return sixb.storage.agents
}
