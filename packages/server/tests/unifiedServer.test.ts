import { describe, expect, test } from "bun:test"
import { createServer } from "node:net"
import {
  InMemoryBlobStorage,
  InMemoryBroker,
  InMemoryLakeStorage,
  InMemoryQueues,
  InMemoryStorage,
  type OntologySource,
  SixbHost,
  type SixbHostOptions,
} from "@sixb/core"
import type { EventsRuntime } from "@sixb/core/internal/events"
import { SixbServer } from "../src/server"
import { createTestBrowserPolicy } from "./helpers"

function createSixbInstance<TOntologySources extends readonly OntologySource[]>(
  options: SixbHostOptions<TOntologySources>
): SixbHost<TOntologySources> {
  return new SixbHost<TOntologySources>(options)
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

      const { port } = address
      server.close((error) => {
        if (error) reject(error)
        else resolvePromise(port)
      })
    })
  })
}

async function waitForWsMessages(
  url: string,
  count: number,
  outgoingMessage?: string
): Promise<Record<string, unknown>[]> {
  return await new Promise<Record<string, unknown>[]>((resolvePromise, reject) => {
    const ws = new WebSocket(url)
    const messages: Record<string, unknown>[] = []
    const timeout = setTimeout(() => {
      ws.close()
      reject(new Error("Timed out waiting for websocket messages"))
    }, 3000)

    ws.addEventListener("message", (event) => {
      const raw =
        typeof event.data === "string"
          ? event.data
          : event.data instanceof ArrayBuffer
            ? new TextDecoder().decode(event.data)
            : String(event.data)

      try {
        const message = JSON.parse(raw) as Record<string, unknown>
        messages.push(message)

        if (messages.length === 1 && outgoingMessage) {
          setTimeout(() => {
            ws.send(outgoingMessage)
          }, 0)
        }

        if (messages.length >= count) {
          clearTimeout(timeout)
          ws.close()
          resolvePromise(messages)
        }
      } catch (error) {
        clearTimeout(timeout)
        ws.close()
        reject(error)
      }
    })

    ws.addEventListener("error", () => {
      clearTimeout(timeout)
      ws.close()
      reject(new Error("WebSocket error"))
    })
  })
}

describe("SixbServer API serving", () => {
  async function withUnifiedServer(
    run: (context: { baseUrl: string }) => Promise<void>
  ): Promise<void> {
    const port = await getFreePort()
    const baseUrl = `http://127.0.0.1:${port}`

    const sixb = createSixbInstance<readonly OntologySource[]>({
      id: "test-project",
      ontology: [],
      broker: new InMemoryBroker(),
      storage: new InMemoryStorage(),
      lakeStorage: new InMemoryLakeStorage(),
      blobStorage: new InMemoryBlobStorage(),
      queues: new InMemoryQueues(),
    })

    await (sixb.events as EventsRuntime).publishEnvelopes([
      {
        id: "telemetry-fan-1-rpm",
        schemaVersion: 1,
        projectId: sixb.id,
        origin: { kind: "runtime", requestId: "seed-fan-1-rpm" },
        commitId: "commit-fan-1-rpm",
        commitOrdinal: 0,
        type: "telemetry.appended",
        topic: "telemetry",
        partitionKey: "device:fan-1:rpm",
        occurredAt: "2026-02-18T10:00:10.000Z",
        payload: {
          objectTypeId: "device",
          objectId: "fan-1",
          propertyId: "rpm",
          value: 1200,
          at: "2026-02-18T10:00:10.000Z",
        },
      },
    ])

    const server = new SixbServer({
      host: sixb,
      hostname: "127.0.0.1",
      port,
      quiet: true,
      browser: createTestBrowserPolicy({ apiOrigin: baseUrl, atlasOrigin: baseUrl }),
    })

    await server.start()

    try {
      await run({ baseUrl })
    } finally {
      await server.stop()
    }
  }

  test("routes API paths to Elysia", async () => {
    await withUnifiedServer(async ({ baseUrl }) => {
      const response = await fetch(`${baseUrl}/api/project`)
      expect(response.status).toBe(200)

      const body = (await response.json()) as { id: string }
      expect(body.id).toBe("test-project")
    })
  })

  test("does not serve Atlas assets or SPA shell routes", async () => {
    await withUnifiedServer(async ({ baseUrl }) => {
      const staticResponse = await fetch(`${baseUrl}/favicon.svg`)
      expect(staticResponse.status).toBe(404)

      const spaResponse = await fetch(`${baseUrl}/dashboard/devices`)
      expect(spaResponse.status).toBe(404)
    })
  })

  test("opens websocket connections on /ws/events", async () => {
    await withUnifiedServer(async ({ baseUrl }) => {
      const wsUrl = baseUrl.replace("http://", "ws://")
      const [message] = await waitForWsMessages(`${wsUrl}/ws/events`, 1)

      expect(message).toEqual({
        type: "connected",
        channel: "events",
      })
    })
  })

  test("returns websocket errors for invalid messages", async () => {
    await withUnifiedServer(async ({ baseUrl }) => {
      const wsUrl = baseUrl.replace("http://", "ws://")
      const messages = await waitForWsMessages(`${wsUrl}/ws/events`, 2, "not-json")

      expect(messages[0]).toEqual({
        type: "connected",
        channel: "events",
      })
      expect(messages[1]).toEqual({
        type: "error",
        message: "Message must be a JSON object.",
      })
    })
  })
})
