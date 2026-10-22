import { describe, expect, test } from "bun:test"
import { SixbHost } from "../src"
import { emptyGrantIndex } from "../src/authorization"
import { bindRequestExecution } from "../src/execution/request"
import {
  createModelCatalog,
  defineModelRateCard,
  rateModelCall,
  type SpeechModel,
  type SpeechModelRequest,
  SpeechModelResponseError,
} from "../src/models"
import { createTestRuntimeDeps } from "./test-runtime-deps"

const MP3 = new Uint8Array([255, 243, 196, 196, 1])

function createSpeechModel(
  speak: SpeechModel["speak"] = async () => ({
    output: { audio: { data: MP3, mediaType: "audio/mpeg" } },
    usage: { inputCharacters: 12 },
    reportedCost: { money: { currency: "USD", amountNanos: "180000" } },
  }),
  overrides: Partial<SpeechModel> = {},
  definition: Partial<SpeechModel["definition"]> = {}
): SpeechModel {
  return {
    providerId: "test",
    modelId: "voice",
    defaultVoice: "alloy",
    definition: {
      kind: "speech",
      providerId: "test",
      modelId: "voice",
      maxInputCharacters: 40,
      voices: ["alloy", "nova"],
      outputMediaTypes: ["audio/mpeg", "audio/wav"],
      instructions: false,
      ...definition,
    },
    speak,
    ...overrides,
  }
}

async function setup(model = createSpeechModel()) {
  const deps = createTestRuntimeDeps()
  const host = new SixbHost({
    id: "speech",
    ontology: [],
    ...deps,
    models: { audio: { speech: [model] } },
  })
  const controller = new AbortController()
  const sixb = bindRequestExecution(host, {
    request: new Request("http://localhost/speak", { signal: controller.signal }),
    authorization: { type: "disabled" },
  })
  return {
    ...deps,
    host,
    sixb,
    controller,
    identity: { projectId: host.id, executionId: sixb.execution.id },
  }
}

describe("speech generation", () => {
  // Removal proof: remove assertProviderAccess from audio/speech.ts; the protected call succeeds.
  test("denies principal-scoped calls before invoking a provider", async () => {
    let calls = 0
    const { host } = await setup(
      createSpeechModel(async () => {
        calls++
        return { output: { audio: { data: MP3, mediaType: "audio/mpeg" } } }
      })
    )
    const scoped = bindRequestExecution(host, {
      request: new Request("http://localhost/speak"),
      authorization: {
        type: "principal",
        context: {
          principal: { type: "user", id: "user" },
          groupIds: [],
          roleIds: [],
          grants: emptyGrantIndex(),
        },
      },
    })

    await expect(scoped.models.audio.speak({ text: "Hello there." })).rejects.toThrow(
      "not covered by scoped authorization"
    )
    expect(calls).toBe(0)
  })

  // Removal proof: omit onModelCallEnd in audio/speech.ts; the durable-usage assertion fails.
  test("stores the audio and records the call's characters, kind and cost", async () => {
    const { sixb, blobStorage, storage, identity } = await setup()

    const result = await sixb.models.audio.speak({ text: "Hello there." })

    expect(result.file.mediaType).toBe("audio/mpeg")
    const stored = new Uint8Array(
      await new Response(await blobStorage.open(result.file.blobId)).arrayBuffer()
    )
    expect(stored).toEqual(MP3)
    expect(result.usage).toEqual({ inputCharacters: 12 })
    expect(result.cost).toMatchObject({ status: "reported", money: { amountNanos: "180000" } })
    expect(await storage.aiUsage.getLatestForExecution(identity)).toMatchObject({
      modelKind: "speech",
      callId: result.callId,
      usage: { inputCharacters: 12, reportingStatus: "partial" },
    })
  })

  test("falls back to the binding's voice and passes the request through", async () => {
    const requests: SpeechModelRequest[] = []
    const { sixb } = await setup(
      createSpeechModel(async ({ signal: _, ...request }) => {
        requests.push(request)
        return { output: { audio: { data: MP3, mediaType: "audio/wav" } } }
      })
    )

    await sixb.models.audio.speak({ text: "Hello there.", mediaType: "audio/wav" })
    await sixb.models.audio.speak({ text: "Hi.", voice: "nova", speed: 1.25, language: "en" })

    expect(requests).toEqual([
      { text: "Hello there.", voice: "alloy", mediaType: "audio/wav" },
      { text: "Hi.", voice: "nova", speed: 1.25, language: "en" },
    ])
  })

  // Removal proof: drop pricingDimensions from estimateModelCall in audio/speech.ts; the card has
  // no default price, so the call becomes unpriceable.
  test("prices a call by the voice tier the provider billed", async () => {
    const rateCard = defineModelRateCard({
      currency: "USD",
      characters: {
        variants: [
          { voiceTier: "standard", price: "4" },
          { voiceTier: "neural", price: "16" },
        ],
      },
    })
    const { sixb } = await setup(
      createSpeechModel(
        async () => ({
          output: { audio: { data: MP3, mediaType: "audio/mpeg" } },
          usage: { inputCharacters: 12 },
          pricingDimensions: { voiceTier: "neural" },
        }),
        {
          costEstimator: {
            estimate: ({ usage, dimensions }) => rateModelCall({ usage, rateCard, dimensions }),
          },
        }
      )
    )

    expect((await sixb.models.audio.speak({ text: "Hello there." })).cost).toMatchObject({
      status: "rated",
      money: { amountNanos: "192000" },
      components: [{ meter: "characters.input", quantity: "12", variant: "neural" }],
    })
  })

  test("rejects requests the model cannot serve before inference", async () => {
    let calls = 0
    const { sixb } = await setup(
      createSpeechModel(async () => {
        calls++
        return { output: { audio: { data: MP3, mediaType: "audio/mpeg" } } }
      })
    )

    for (const [input, message] of [
      [{ text: " " }, "nonblank text"],
      [{ text: "x".repeat(41) }, "40-character"],
      [{ text: "Hi.", voice: "echo" }, "Voice 'echo'"],
      [{ text: "Hi.", mediaType: "audio/ogg" }, "not supported"],
      [{ text: "Hi.", mediaType: "text/plain" }, "audio media type"],
      [{ text: "Hi.", instructions: "whisper" }, "instructions"],
      [{ text: "Hi.", speed: 0 }, "positive number"],
    ] as const) {
      await expect(sixb.models.audio.speak(input)).rejects.toThrow(message)
    }
    expect(calls).toBe(0)
  })

  test("records invalid replies once and never retries inference", async () => {
    let calls = 0
    const { sixb, storage, identity } = await setup(
      createSpeechModel(async () => {
        calls++
        return {
          output: { audio: { data: MP3, mediaType: "audio/wav" } },
          usage: { inputCharacters: 3 },
        }
      })
    )

    await expect(
      sixb.models.audio.speak({ text: "Hi.", mediaType: "audio/mpeg" })
    ).rejects.toBeInstanceOf(SpeechModelResponseError)
    expect(calls).toBe(1)
    expect(await storage.aiUsage.getLatestForExecution(identity)).toMatchObject({
      modelKind: "speech",
      usage: { inputCharacters: 3 },
    })
  })

  test("accounts for a late billable reply after cancellation", async () => {
    const { sixb, controller, storage, identity, blobStorage } = await setup(
      createSpeechModel(async () => {
        controller.abort()
        return {
          output: { audio: { data: MP3, mediaType: "audio/mpeg" } },
          usage: { inputCharacters: 3 },
        }
      })
    )
    let writes = 0
    const put = blobStorage.put.bind(blobStorage)
    blobStorage.put = async (input) => {
      writes++
      return put(input)
    }

    await expect(sixb.models.audio.speak({ text: "Hi." })).rejects.toThrow()
    expect(writes).toBe(0)
    expect(await storage.aiUsage.getLatestForExecution(identity)).toMatchObject({
      usage: { inputCharacters: 3 },
    })
  })

  // Removal proof: drop reservationCost from the speech admission; the cost limit refuses the call.
  test("reserves the binding's estimate under a cost limit", async () => {
    let reservation: unknown
    const { sixb, storage } = await setup(
      createSpeechModel(undefined, {
        costEstimator: {
          estimateReservation: (input) => {
            reservation = input
            return { currency: "USD", amountNanos: "180000" }
          },
          estimate: () => ({ status: "unpriceable", reason: "missing-rate-card" }),
        },
      })
    )
    await storage.aiLimits.createPolicy({
      id: "cost",
      projectId: "speech",
      subject: { type: "project" },
      limit: {
        meter: "cost.catalogEstimated",
        amount: { currency: "USD", amountNanos: "1000000000" },
      },
    })

    await sixb.models.audio.speak({ text: "Hello there." })

    expect(reservation).toEqual({ text: "Hello there.", voice: "alloy" })
  })

  test("uses the configured binding and validates catalog shape", async () => {
    const { sixb } = await setup()
    const impostor = createSpeechModel(async () => {
      throw new Error("impostor")
    })

    expect((await sixb.models.audio.speak({ text: "Hi.", model: impostor })).usage).toEqual({
      inputCharacters: 12,
    })
    await expect(
      sixb.models.audio.speak({ text: "Hi.", model: { ...impostor, modelId: "other" } })
    ).rejects.toThrow("Configure")
    expect(() => createModelCatalog({ audio: {} })).toThrow("transcription or speech")
    expect(() => createModelCatalog({ audio: { speech: [] } })).toThrow("at least one")
    expect(() =>
      createModelCatalog({
        audio: { speech: [createSpeechModel(undefined, { defaultVoice: "echo" })] },
      })
    ).toThrow("defaultVoice")
  })
})
