import { expect, test } from "bun:test"
import { createVercelGateway } from "../src"

const audio = new Uint8Array([1, 2, 3])
const payload = {
  text: "Hello",
  durationInSeconds: 1.25,
  usage: { inputTokens: 9, custom: 7 },
  providerMetadata: { gateway: { cost: "0.00015", generationId: "gen_audio123" } },
}
const catalog = {
  data: [
    {
      id: "test/transcribe",
      type: "transcription",
      pricing: { transcription_duration_cost_per_second: "0.0001" },
    },
  ],
}

test("transcription uses the v4 JSON protocol and rotating Gateway credentials", async () => {
  let key = "first"
  let calls = 0
  const options = { providerOptions: { custom: { language: "fr" } } }
  const model = createVercelGateway({
    baseUrl: "https://gateway.test/prefix/v1/",
    apiKey: () => key,
    fetch: async (url, init) => {
      calls++
      expect(url).toBe("https://gateway.test/prefix/v4/ai/transcription-model")
      const headers = new Headers(init?.headers)
      expect(headers.get("authorization")).toBe(`Bearer ${key}`)
      expect(headers.get("ai-model-id")).toBe("test/transcribe")
      expect(headers.get("ai-gateway-protocol-version")).toBe("0.0.1")
      expect(headers.get("ai-transcription-model-specification-version")).toBe("4")

      expect(JSON.parse(String(init?.body))).toEqual({
        audio: "AQID",
        mediaType: "audio/wav",
        providerOptions: { custom: { language: "fr" } },
      })

      return Response.json(payload, { headers: { "x-request-id": "req_audio" } })
    },
  }).transcription("test/transcribe", options)

  options.providerOptions.custom.language = "de"
  expect(calls).toBe(0)

  for (key of ["first", "rotated"]) {
    const result = await model.transcribe({ audio, mediaType: "audio/wav" })

    expect(result).toMatchObject({
      output: { text: "Hello" },
      usage: { audioDurationMs: 1250, raw: payload.usage },
      providerIds: { requestId: "req_audio", generationId: "gen_audio123" },
      reportedCost: { money: { amountNanos: "150000" } },
    })
    // Usage is provider-specific in this protocol; unknown token semantics stay raw.
    expect(result.usage?.inputTokens).toBeUndefined()
  }
  expect(calls).toBe(2)
})

// Removal proof: drop metadata from TranscriptionModelResponseError; these billing assertions fail.
test("invalid transcript retains provider billing and duration", async () => {
  const model = createVercelGateway({
    fetch: async () => Response.json({ ...payload, text: null }),
  }).transcription("test/transcribe")
  await expect(model.transcribe({ audio, mediaType: "audio/wav" })).rejects.toMatchObject({
    code: "invalid_transcription_response",
    metadata: {
      usage: { audioDurationMs: 1250 },
      reportedCost: { money: { amountNanos: "150000" } },
    },
  })
})

test("per-second catalog pricing is a pinned estimate, with unknown durations preserved", async () => {
  const gateway = createVercelGateway({ fetch: async () => Response.json(catalog) })
  const model = await gateway.transcription("test/transcribe").resolve!()

  const estimate = model.costEstimator?.estimate({ usage: { audioDurationMs: 1250 } })

  expect(estimate).toMatchObject({
    status: "rated",
    money: { amountNanos: "125000" },
    components: [{ meter: "audio.input.milliseconds", quantity: "1250" }],
  })
  expect(model.costEstimator?.estimate({ usage: {} })).toMatchObject({
    status: "unpriceable",
    reason: "missing-usage",
  })
  expect(model.costEstimator?.estimateReservation).toBeUndefined()
  expect(
    model.costEstimator?.estimate({
      usage: { audioDurationMs: 1250 },
      route: { modelId: "different" },
    }).status
  ).toBe("unpriceable")
})

test("routing overrides and token-only tariffs do not become duration rates", async () => {
  for (const gateway of [
    createVercelGateway({
      fetch: async () =>
        Response.json({
          data: [
            {
              id: "test/transcribe",
              type: "transcription",
              pricing: { input: "0.01", output: "0.02" },
            },
          ],
        }),
    }),
    createVercelGateway({ fetch: async () => Response.json(catalog) }),
  ]) {
    const model = await gateway.transcription("test/transcribe", {
      providerOptions: { gateway: { models: ["other"] } },
    }).resolve!()
    expect(model.costEstimator?.estimate({ usage: { audioDurationMs: 1250 } }).status).toBe(
      "unpriceable"
    )
  }
})

test("provider rejections do not retry or expose upstream request content", async () => {
  let calls = 0
  const model = createVercelGateway({
    maxRetries: 5,
    fetch: async () => {
      calls++
      return new Response("private audio and credentials", { status: 503 })
    },
  }).transcription("test/transcribe")
  await expect(model.transcribe({ audio, mediaType: "audio/wav" })).rejects.toMatchObject({
    status: 503,
    retryable: false,
    message: "[SixbVercelGateway] Transcription returned HTTP 503.",
  })
  expect(calls).toBe(1)
})

test("input size guard and proxy URL validation precede the request", async () => {
  let calls = 0
  const gateway = createVercelGateway({
    fetch: async () => {
      calls++
      return Response.json(payload)
    },
  })
  await expect(
    gateway
      .transcription("test/transcribe", { maxInputBytes: 2 })
      .transcribe({ audio, mediaType: "audio/wav" })
  ).rejects.toThrow("maxInputBytes")
  expect(calls).toBe(0)

  expect(() =>
    createVercelGateway({ baseUrl: "https://gateway.test/custom" }).transcription("test/transcribe")
  ).toThrow("transcriptionUrl")
})

test("oversized and interrupted response streams are bounded", async () => {
  const oversized = createVercelGateway({
    fetch: async () =>
      new Response("{}", { headers: { "content-length": String(9 * 1024 * 1024) } }),
  }).transcription("test/transcribe")
  await expect(oversized.transcribe({ audio, mediaType: "audio/wav" })).rejects.toMatchObject({
    code: "invalid_response",
  })

  const controller = new AbortController()
  let cancelled = false
  const model = createVercelGateway({
    fetch: async () =>
      new Response(
        new ReadableStream({
          pull() {
            controller.abort()
          },
          cancel() {
            cancelled = true
          },
        })
      ),
  }).transcription("test/transcribe")
  await expect(
    model.transcribe({ audio, mediaType: "audio/wav", signal: controller.signal })
  ).rejects.toThrow()
  expect(cancelled).toBe(true)
})

test("unreported or invalid durations remain unknown and zero is preserved", async () => {
  for (const durationInSeconds of [undefined, -1, 1e100, "2", 0]) {
    const model = createVercelGateway({
      fetch: async () => Response.json({ text: "", durationInSeconds }),
    }).transcription("test/transcribe")
    const result = await model.transcribe({ audio, mediaType: "audio/wav" })
    expect(result.usage?.audioDurationMs).toBe(durationInSeconds === 0 ? 0 : undefined)
  }
})
