import { expect, test } from "bun:test"
import { createVercelGateway } from "../src"

const MP3 = new Uint8Array([0x49, 0x44, 0x33, 4, 0, 0])
const WAV = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x41, 0x56, 0x45])
const base64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64")

// Shapes and prices from Vercel's live catalog on 2026-10-22.
const catalog = {
  data: [
    {
      id: "openai/tts-1",
      type: "speech",
      name: "TTS-1",
      pricing: { input: "0.000015", speech_input_character_cost: "0.000015" },
    },
    {
      id: "google/gemini-3.8-flash-lite-tts",
      type: "speech",
      pricing: { input: "0.0000005", output: "0.000006", audio_output_token_cost: "0.000006" },
    },
  ],
}

function gateway(reply: () => Response) {
  const requests: { url: string; headers: Headers; body: Record<string, unknown> }[] = []
  const provider = createVercelGateway({
    baseUrl: "https://gateway.test/prefix/v1",
    apiKey: "key",
    fetch: async (url, init) => {
      if (String(url).endsWith("/models")) return Response.json(catalog)
      requests.push({
        url: String(url),
        headers: new Headers(init?.headers),
        body: JSON.parse(String(init?.body)),
      })
      return reply()
    },
  })
  return { provider, requests }
}

test("speech uses the v4 speech protocol and returns a typed, playable file", async () => {
  const { provider, requests } = gateway(() =>
    Response.json(
      {
        audio: base64(MP3),
        warnings: [{ type: "unsupported", feature: "language" }],
        providerMetadata: { gateway: { cost: "0.00018", generationId: "gen_speech1" } },
      },
      { headers: { "x-request-id": "req_speech" } }
    )
  )
  const model = await provider.speech("openai/tts-1", {
    voice: "alloy",
    description: "Short notifications",
  }).resolve!()
  expect(model).toMatchObject({
    defaultVoice: "alloy",
    definition: { name: "TTS-1", description: "Short notifications" },
  })

  const result = await model.speak({
    text: "Hello there.",
    voice: "nova",
    mediaType: "audio/mpeg",
    instructions: "warm",
    speed: 1.25,
    language: "en",
  })

  expect(requests[0]!.url).toBe("https://gateway.test/prefix/v4/ai/speech-model")
  expect(requests[0]!.headers.get("ai-speech-model-specification-version")).toBe("4")
  expect(requests[0]!.headers.get("ai-model-id")).toBe("openai/tts-1")
  expect(requests[0]!.body).toEqual({
    text: "Hello there.",
    voice: "nova",
    outputFormat: "mp3",
    instructions: "warm",
    speed: 1.25,
    language: "en",
  })
  expect(result).toMatchObject({
    output: { audio: { data: MP3, mediaType: "audio/mpeg" } },
    warnings: ["unsupported: language"],
    usage: { inputCharacters: 12 },
    providerIds: { requestId: "req_speech", generationId: "gen_speech1" },
    reportedCost: { money: { amountNanos: "180000" } },
  })
})

// Removal proof: count characters as code points in speech.ts; the bill below no longer matches.
test("characters are counted the way the Gateway bills them", async () => {
  const { provider } = gateway(() =>
    Response.json({ audio: base64(MP3), providerMetadata: { gateway: { cost: "0.000165" } } })
  )
  const model = await provider.speech("openai/tts-1").resolve!()
  expect(model.rateCard).toEqual({ currency: "USD", characters: "15" })
  // Measured: the Gateway billed this text as 11 characters (UTF-16 units), not 10 or 18.
  const text = "héllo 👋 日本"

  const result = await model.speak({ text })

  expect(result.usage).toEqual({ inputCharacters: 11 })
  expect(model.costEstimator?.estimate({ usage: result.usage! })).toMatchObject({
    status: "rated",
    money: { amountNanos: "165000" },
  })
  expect(model.costEstimator?.estimateReservation?.({ text })).toEqual({
    currency: "USD",
    amountNanos: "165000",
  })
})

test("token-priced speech prices reported tokens but cannot reserve", async () => {
  const { provider } = gateway(() =>
    Response.json({
      audio: base64(WAV),
      providerMetadata: { google: { mimeType: "audio/wav" }, gateway: { cost: "0.0001755" } },
    })
  )
  const model = await provider.speech("google/gemini-3.8-flash-lite-tts").resolve!()
  expect(model.rateCard).toEqual({ currency: "USD", input: "0.5", output: "6", audioOutput: "6" })

  expect((await model.speak({ text: "Hello there." })).output.audio.mediaType).toBe("audio/wav")
  expect(model.costEstimator?.estimateReservation?.({ text: "Hello there." })).toBeUndefined()
  expect(
    model.costEstimator?.estimate({
      usage: { inputTokens: 3, outputTokens: 29, audioOutputTokens: 29 },
    })
  ).toMatchObject({ status: "rated", money: { amountNanos: "175500" } })
  // The speech endpoint reports no tokens; the reported cost is the bill.
  expect(model.costEstimator?.estimate({ usage: { inputCharacters: 12 } })).toMatchObject({
    status: "unpriceable",
    reason: "missing-usage",
  })
})

test("formats are requested by media type and never guessed", async () => {
  const { provider } = gateway(() =>
    Response.json({ audio: base64(new Uint8Array([1, 2, 3])), providerMetadata: {} })
  )
  expect(() => provider.speech("openai/tts-1", { outputMediaTypes: ["audio/x-unknown"] })).toThrow(
    "outputMediaTypes"
  )
  const model = await provider.speech("openai/tts-1").resolve!()
  expect(model.definition.outputMediaTypes).toContain("audio/ogg")

  await expect(model.speak({ text: "Hi." })).rejects.toMatchObject({
    code: "invalid_speech_response",
    metadata: { usage: { inputCharacters: 3 } },
  })
})
