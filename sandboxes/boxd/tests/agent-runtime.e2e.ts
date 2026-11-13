import { expect, test } from "bun:test"
import {
  defineGroup,
  defineObjectType,
  InMemoryBlobStorage,
  InMemoryBroker,
  InMemoryLakeStorage,
  InMemoryQueues,
  InMemoryStorage,
  prop,
  type Sandbox,
  SixbHost,
} from "@sixb/core"
import { createTestSixb } from "@sixb/core/testing"
import { WorkerTestModel } from "../../../packages/agent/tests/worker-model-fixture"
import { AgentWorker } from "../../../packages/agent-worker/src"
import { createSixbApi, SixbServer } from "../../../packages/server/src/server"
import { liveEnabled, liveFactory } from "./live"

/**
 * The real agent worker, CLI and run-token API against a boxd machine. The machine reaches the
 * Sixb API over the internet, so this needs a public HTTPS origin that forwards to a local port,
 * such as a tunnel. Only requests carrying a run token are answered there.
 *
 *   SIXB_BOXD_E2E=1 SIXB_BOXD_AGENT_ORIGIN=https://api.example.dev SIXB_BOXD_AGENT_PORT=8000 \
 *   bun test --timeout 300000 ./sandboxes/boxd/tests/agent-runtime.e2e.ts
 */
const publicOrigin = process.env.SIXB_BOXD_AGENT_ORIGIN
const port = Number(process.env.SIXB_BOXD_AGENT_PORT)
const enabled = liveEnabled && publicOrigin !== undefined && Number.isInteger(port)
test.skipIf(!enabled)(
  "boxd completes an agent task through the real Sixb API over HTTPS",
  async () => {
    const factory = liveFactory()
    const sessions: Sandbox[] = []
    let calls = 0
    let replay = ""
    const model = new WorkerTestModel({
      generate: async (request) => {
        calls++
        if (calls === 1)
          return {
            content: [
              {
                type: "tool-call",
                toolCallId: "read-device",
                toolName: "bash",
                input: JSON.stringify({ command: "sixb objects get Device fan-1" }),
              },
            ],
            finishReason: "tool-calls",
            usage: {},
          }
        replay = JSON.stringify(request.messages)
        return {
          content: [{ type: "text", text: "The test fan is healthy." }],
          finishReason: "stop",
          usage: {},
        }
      },
    })
    const storage = new InMemoryStorage()
    const host = new SixbHost({
      id: "boxd-runtime-test",
      ontology: [
        defineObjectType({
          id: "Device",
          name: "Device",
          properties: [
            prop("id", "string", { primary: true, required: true }),
            prop("label", "string"),
          ],
        }),
      ],
      groups: [defineGroup("agent-runtime", { label: "Agent runtime" })],
      storage,
      broker: new InMemoryBroker(),
      lakeStorage: new InMemoryLakeStorage(),
      blobStorage: new InMemoryBlobStorage(),
      queues: new InMemoryQueues(),
      models: { language: [model] },
      sandboxes: {
        supportsRequestCredentials: factory.supportsRequestCredentials,
        async create(options) {
          const sandbox = await factory.create(options)
          sessions.push(sandbox)
          console.log(`[BoxdE2E] Agent sandbox ${sandbox.id}`)
          return sandbox
        },
      },
    })
    const api = createTestSixb(host)
    await api.objects.upsert("Device", { id: "fan-1", label: "Synthetic healthy fan" })
    let app: ReturnType<typeof createSixbApi> | undefined
    let runTokenRequests = 0
    const server = Bun.serve({
      hostname: "0.0.0.0",
      port,
      fetch(request) {
        // The public origin answers only an Agent's run token: no session, app or admin request.
        if (!request.headers.get("authorization")?.startsWith("Bearer sixb_run_v1_"))
          return new Response("Not found", { status: 404 })
        runTokenRequests++
        return app ? app.fetch(request) : new Response("Starting", { status: 503 })
      },
    })
    let worker: AgentWorker | undefined
    try {
      const origin = new URL(publicOrigin ?? "").origin
      app = createSixbApi(
        new SixbServer({
          host,
          quiet: true,
          browser: { publicOrigin: origin, allowedOrigins: [origin] },
        })
      )
      worker = new AgentWorker(host, {
        apiBaseUrl: origin,
      })
      const requested = await api.agent.runs.request({
        text: "Read Device fan-1 using the Sixb CLI and report its label.",
      })
      await worker.start()
      const deadline = Date.now() + 150_000
      for (;;) {
        const run = await storage.agents.runs.getById({ projectId: host.id, id: requested.run.id })
        if (run?.status === "succeeded" || run?.status === "failed") {
          expect(run.status).toBe("succeeded")
          break
        }
        if (Date.now() >= deadline) throw new Error("Agent run did not finish")
        await Bun.sleep(200)
      }
      expect(calls).toBe(2)
      expect(replay).toContain("Synthetic healthy fan")
      expect(replay).toContain("exitCode")
      expect(runTokenRequests).toBeGreaterThanOrEqual(2) // status + object read
      expect(sessions).toHaveLength(1)
      console.log("[BoxdE2E] Runtime preflight, CLI read and agent completion passed")
    } finally {
      // Close public access even when worker/sandbox teardown reports a failure.
      try {
        await worker?.stop()
      } finally {
        const cleanup = await Promise.allSettled(sessions.map((session) => session.destroy()))
        await server.stop(true)
        await host.closeBroker()
        await host.closeBlobs()
        await host.closeLogger()
        const failed = cleanup.find((result) => result.status === "rejected")
        expect(failed, "all boxd test sandboxes must be deleted").toBeUndefined()
      }
    }
  },
  240_000
)
