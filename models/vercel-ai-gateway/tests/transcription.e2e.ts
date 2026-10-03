import { expect, test } from "bun:test"
import {
  InMemoryBlobStorage,
  InMemoryBroker,
  InMemoryLakeStorage,
  InMemoryQueues,
  InMemoryStorage,
  SixbHost,
} from "@sixb/core"
import { createTestSixb } from "@sixb/core/testing"
import { createVercelGateway } from "../src"

const modelId = process.env.SIXB_VERCEL_GATEWAY_TRANSCRIPTION_E2E_MODEL
const filePath = process.env.SIXB_VERCEL_GATEWAY_TRANSCRIPTION_E2E_FILE
const mediaType = process.env.SIXB_VERCEL_GATEWAY_TRANSCRIPTION_E2E_MEDIA_TYPE
const credential = process.env.AI_GATEWAY_API_KEY || process.env.VERCEL_OIDC_TOKEN

// Explicitly opt in: one bounded, potentially billable request with the selected test file.
test.skipIf(!modelId || !filePath || !mediaType || !credential)(
  "transcribes a file through live Gateway and persists accounting",
  async () => {
    if (!modelId || !filePath || !mediaType)
      throw new Error("Missing live transcription configuration")
    let inferenceCalls = 0
    const gateway = createVercelGateway({
      fetch: (url, init) => {
        if (String(url).endsWith("/transcription-model")) inferenceCalls++
        return fetch(url, init)
      },
    })
    const storage = new InMemoryStorage()
    const blobStorage = new InMemoryBlobStorage()
    const host = new SixbHost({
      id: "gateway-transcription",
      ontology: [],
      storage,
      blobStorage,
      broker: new InMemoryBroker(),
      lakeStorage: new InMemoryLakeStorage(),
      queues: new InMemoryQueues(),
      models: { audio: { transcription: [gateway.transcription(modelId, { timeoutMs: 40_000 })] } },
    })
    const file = Bun.file(filePath)
    if (file.size > 25 * 1024 * 1024) throw new Error("Test file exceeds the client input limit")
    const audio = await blobStorage.put({ body: file, mediaType })
    const sixb = createTestSixb(host)
    const result = await sixb.models.audio.transcribe({
      audio,
      signal: AbortSignal.timeout(40_000),
    })
    expect(typeof result.output.text).toBe("string")
    expect(inferenceCalls).toBe(1)
    const record = await storage.aiUsage.getLatestForExecution({
      projectId: host.id,
      executionId: sixb.execution.id,
    })
    expect(record).toMatchObject({
      callId: result.callId,
      modelKind: "transcription",
      requestedModelId: modelId,
    })
    expect(record?.usage.audioDurationMs).toBe(result.usage.audioDurationMs)
    console.info("[SixbVercelGateway] Live transcription verified:", {
      modelId,
      durationMs: result.usage.audioDurationMs,
      cost: result.cost,
      inferenceCalls,
    })
  },
  45_000
)
