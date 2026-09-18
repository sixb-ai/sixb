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
import { AgentWorker } from "../../../packages/agent-worker/src"
import { WorkerTestModel } from "../../../packages/agent-worker/tests/worker-model-fixture"
import { createSixbApi, SixbServer } from "../../../packages/server/src/server"
import { AzureSandboxFactory } from "../src"
import { buildGuestArtifact } from "./guest-build"

// Explicit second opt-in: this test exposes only run-capability gateway routes through ngrok.
// Requires an authenticated ngrok CLI and an already prepared Azure disk image.
const enabled = process.env.SIXB_AZURE_AGENT_E2E === "1"
test.skipIf(!enabled)(
  "Azure completes an agent task through the real Sixb gateway over HTTPS",
  async () => {
    await buildGuestArtifact()
    const imageId = process.env.AZURE_SANDBOX_IMAGE_ID
    if (!imageId) throw new Error("AZURE_SANDBOX_IMAGE_ID must identify the prepared runtime image")
    const factory = new AzureSandboxFactory({
      subscriptionId: process.env.AZURE_SUBSCRIPTION_ID!,
      resourceGroup: process.env.AZURE_RESOURCE_GROUP!,
      sandboxGroup: process.env.AZURE_SANDBOX_GROUP!,
      region: process.env.AZURE_SANDBOX_REGION ?? "westus3",
      image: { type: "disk", id: imageId },
      pollIntervalMs: 200,
    })
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
      id: "azure-runtime-test",
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
        async create(options) {
          const sandbox = await factory.create(options)
          sessions.push(sandbox)
          console.log(`[AzureE2E] Agent sandbox ${sandbox.id}`)
          return sandbox
        },
      },
    })
    const api = createTestSixb(host)
    await api.objects.upsert("Device", { id: "fan-1", label: "Synthetic healthy fan" })
    let app: ReturnType<typeof createSixbApi> | undefined
    let gatewayRequests = 0
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        // The public tunnel never exposes normal API routes, Atlas, filesystem, or admin surfaces.
        if (!new URL(request.url).pathname.startsWith("/__sixb/agent-api/"))
          return new Response("Not found", { status: 404 })
        gatewayRequests++
        return app ? app.fetch(request) : new Response("Starting", { status: 503 })
      },
    })
    const tunnel = Bun.spawn(
      [
        "ngrok",
        "http",
        `http://127.0.0.1:${server.port}`,
        "--inspect=false",
        "--log=stdout",
        "--log-format=json",
      ],
      { stdout: "pipe", stderr: "pipe" }
    )
    let worker: AgentWorker | undefined
    try {
      const origin = await tunnelOrigin(tunnel.stdout)
      app = createSixbApi(
        new SixbServer({
          host,
          quiet: true,
          browser: { publicOrigin: origin, allowedOrigins: [{ origin, audience: "atlas" }] },
        })
      )
      console.log("[AzureE2E] Temporary HTTPS tunnel ready")
      worker = new AgentWorker(host, {
        apiBaseUrl: origin,
        skillsDir: false,
        defaultMaxSteps: 3,
        turnTimeoutMs: 120_000,
        idlePollMs: 20,
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
      expect(gatewayRequests).toBeGreaterThanOrEqual(2) // doctor + object read
      expect(sessions).toHaveLength(1)
      console.log("[AzureE2E] Runtime preflight, CLI gateway read and agent completion passed")
    } finally {
      // Close public access even when worker/sandbox teardown reports a failure.
      try {
        await worker?.stop()
      } finally {
        const cleanup = await Promise.allSettled(sessions.map((session) => session.destroy()))
        tunnel.kill()
        await tunnel.exited
        await server.stop(true)
        await host.closeBroker()
        await host.closeBlobs()
        await host.closeLogger()
        const failed = cleanup.find((result) => result.status === "rejected")
        expect(failed, "all Azure test sandboxes must be deleted").toBeUndefined()
      }
    }
  },
  240_000
)

async function tunnelOrigin(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let text = ""
  const timer = setTimeout(() => reader.cancel(), 20_000)
  try {
    for (;;) {
      const chunk = await reader.read()
      if (chunk.done)
        throw new Error(
          "ngrok did not establish a tunnel; check ngrok authentication/configuration"
        )
      text += decoder.decode(chunk.value, { stream: true })
      const lines = text.split("\n")
      text = lines.pop() ?? ""
      for (const line of lines) {
        const entry: unknown = JSON.parse(line)
        if (
          entry &&
          typeof entry === "object" &&
          "msg" in entry &&
          "url" in entry &&
          entry.msg === "started tunnel" &&
          typeof entry.url === "string" &&
          entry.url.startsWith("https://")
        )
          return new URL(entry.url).origin
      }
    }
  } finally {
    clearTimeout(timer)
    reader.releaseLock()
  }
}
