import { expect, test } from "bun:test"
import { createVercelGateway } from "../src"

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2])
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 3, 4])
const base64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64")

// Shapes and prices from Vercel's live catalog on 2026-10-22.
const catalog = {
  data: [
    {
      id: "bfl/flux-3-image",
      type: "image",
      name: "FLUX.3",
      description: "Black Forest Labs' image model.",
      pricing: {
        image: "0.048",
        image_dimension_quality_pricing: [
          { size: "768x768", cost: "0.041" },
          { size: "1024x1024", cost: "0.048" },
        ],
      },
    },
    {
      id: "recraft/recraft-v3",
      type: "image",
      pricing: {
        image: "0.04",
        image_dimension_quality_pricing: [{ style: "vector_illustration", cost: "0.08" }],
      },
    },
    {
      id: "spacexai/grok-imagine-image-2.0",
      type: "image",
      pricing: {
        image_dimension_quality_pricing: [
          { quality: "high", cost: "0.07" },
          { size: "2K", cost: "0.05" },
        ],
      },
    },
    {
      id: "openai/gpt-image-1-mini",
      type: "image",
      pricing: { input: "0.000002", output: "0.000008" },
    },
    {
      id: "google/gemini-3.1-flash-lite-image",
      type: "language",
      tags: ["image-generation"],
      pricing: {
        input: "0.00000025",
        output: "0.0000015",
        image_dimension_quality_pricing: [
          { size: "default", cost: "0.034" },
          { size: "1K", cost: "0.034" },
        ],
      },
    },
    {
      id: "google/gemini-2.5-flash-image",
      type: "language",
      tags: ["image-generation"],
      pricing: { input: "0.0000003", output: "0.0000025" },
    },
  ],
}

function gateway(reply: (url: string, body: Record<string, unknown>) => Response) {
  const requests: { url: string; headers: Headers; body: Record<string, unknown> }[] = []
  const provider = createVercelGateway({
    baseUrl: "https://gateway.test/prefix/v1",
    apiKey: "key",
    fetch: async (url, init) => {
      if (String(url).endsWith("/models")) return Response.json(catalog)
      const body = JSON.parse(String(init?.body))
      requests.push({ url: String(url), headers: new Headers(init?.headers), body })
      return reply(String(url), body)
    },
  })
  return { provider, requests }
}

const request = { prompt: "a fox", n: 1, images: [] }

test("image models use the image endpoint, with quality and style for the routed provider", async () => {
  const { provider, requests } = gateway(() =>
    Response.json(
      {
        images: [base64(PNG), base64(JPEG)],
        warnings: [{ type: "unsupported", feature: "seed", details: "ignored" }],
        usage: { inputTokens: 10, outputTokens: 272 },
        providerMetadata: { gateway: { cost: "0.002196", generationId: "gen_image1" } },
      },
      { headers: { "x-request-id": "req_image" } }
    )
  )
  const model = await provider.image("openai/gpt-image-1-mini", {
    providerOptions: { openai: { background: "opaque" } },
  }).resolve!()

  const result = await model.generate({
    ...request,
    n: 2,
    size: "1024x1024",
    quality: "low",
    seed: 7,
    images: [{ data: PNG, mediaType: "image/png" }],
  })

  expect(requests).toHaveLength(1)
  expect(requests[0]!.url).toBe("https://gateway.test/prefix/v4/ai/image-model")
  expect(requests[0]!.headers.get("ai-model-id")).toBe("openai/gpt-image-1-mini")
  expect(requests[0]!.headers.get("ai-image-model-specification-version")).toBe("4")
  expect(requests[0]!.body).toEqual({
    prompt: "a fox",
    n: 2,
    size: "1024x1024",
    seed: 7,
    providerOptions: { openai: { background: "opaque", quality: "low" } },
    files: [{ type: "file", mediaType: "image/png", data: base64(PNG) }],
  })
  expect(result).toMatchObject({
    output: {
      images: [
        { data: PNG, mediaType: "image/png" },
        { data: JPEG, mediaType: "image/jpeg" },
      ],
    },
    warnings: ["unsupported: seed: ignored"],
    usage: { inputTokens: 10, outputTokens: 272 },
    providerIds: { requestId: "req_image", generationId: "gen_image1" },
    reportedCost: { money: { amountNanos: "2196000" } },
  })
  // Custom provider options may change the tariff, so only a plain binding prices locally.
  expect(model.costEstimator?.estimate({ usage: result.usage! }).status).toBe("unpriceable")
  // Token-priced images match the Gateway's bill from the reported usage.
  const plain = await provider.image("openai/gpt-image-1-mini").resolve!()
  expect(plain.costEstimator?.estimate({ usage: result.usage! })).toMatchObject({
    status: "rated",
    money: { amountNanos: "2196000" },
  })
})

// Removal proof: return the language card without the images check in the catalog; the
// unpriced Gemini model below then rates 1120 image tokens at the text rate.
test("Gemini image models use chat completions and bill images per image", async () => {
  const { provider, requests } = gateway(() =>
    Response.json({
      id: "gen_chat1",
      model: "google/gemini-3.1-flash-lite-image",
      choices: [
        {
          message: {
            role: "assistant",
            content: "",
            images: [
              { type: "image_url", image_url: { url: `data:image/jpeg;base64,${base64(JPEG)}` } },
            ],
            provider_metadata: {
              vertex: {
                usageMetadata: {
                  candidatesTokensDetails: [{ modality: "IMAGE", tokenCount: 1120 }],
                },
              },
              gateway: { cost: "0.0340035", generationId: "gen_chat1" },
            },
          },
        },
      ],
      usage: {
        prompt_tokens: 14,
        completion_tokens: 1120,
        completion_tokens_details: { reasoning_tokens: 0, image_tokens: 0 },
      },
    })
  )
  const model = await provider.image("google/gemini-3.1-flash-lite-image").resolve!()
  expect(model.definition.maxImagesPerCall).toBe(1)

  const result = await model.generate({
    ...request,
    aspectRatio: "16:9",
    size: "1K",
    quality: "hd",
  })

  expect(requests[0]!.url).toBe("https://gateway.test/prefix/v1/chat/completions")
  expect(requests[0]!.body).toEqual({
    model: "google/gemini-3.1-flash-lite-image",
    modalities: ["text", "image"],
    messages: [{ role: "user", content: [{ type: "text", text: "a fox" }] }],
    providerOptions: { google: { imageConfig: { aspectRatio: "16:9", imageSize: "1K" } } },
  })
  expect(result).toMatchObject({
    output: { images: [{ data: JPEG, mediaType: "image/jpeg" }] },
    warnings: ["unsupported: quality"],
    usage: {
      inputTokens: 14,
      outputTokens: 1120,
      imageOutputTokens: 1120,
      textOutputTokens: 0,
      reasoningOutputTokens: 0,
    },
    reportedCost: { money: { amountNanos: "34003500" } },
  })
  expect(
    model.costEstimator?.estimate({
      usage: { ...result.usage, outputImages: 1 },
      dimensions: { size: "1K" },
    })
  ).toMatchObject({ status: "rated", money: { amountNanos: "34003500" } })

  const unpriced = await provider.image("google/gemini-2.5-flash-image").resolve!()
  expect(unpriced.costEstimator?.estimate({ usage: { ...result.usage, outputImages: 1 } })).toEqual(
    { status: "unpriceable", reason: "missing-rate-card" }
  )
})

test("catalog prices images by the variant a request matches, or not at all", async () => {
  const { provider } = gateway(() => Response.json({}))
  const estimate = async (modelId: string, dimensions: Record<string, string>) =>
    (await provider.image(modelId).resolve!()).costEstimator?.estimate({
      usage: { outputImages: 2 },
      dimensions,
    })

  // Removal proof: drop pricedSizes from imageResolution; no model lists its sizes.
  expect((await provider.image("bfl/flux-3-image").resolve!()).definition.sizes).toEqual([
    "768x768",
    "1024x1024",
  ])
  expect(
    (await provider.image("google/gemini-3.1-flash-lite-image").resolve!()).definition.sizes
  ).toEqual(["1K"])
  // Token-priced, or priced by style: any size passes through.
  expect(
    (await provider.image("openai/gpt-image-1-mini").resolve!()).definition.sizes
  ).toBeUndefined()
  expect((await provider.image("recraft/recraft-v3").resolve!()).definition.sizes).toBeUndefined()
  expect((await provider.image("bfl/flux-3-image").resolve!()).rateCard).toEqual({
    currency: "USD",
    images: {
      default: "0.048",
      variants: [
        { size: "768x768", price: "0.041" },
        { size: "1024x1024", price: "0.048" },
      ],
    },
  })
  expect(await estimate("bfl/flux-3-image", { size: "768x768" })).toMatchObject({
    money: { amountNanos: "82000000" },
    components: [{ meter: "images.output", variant: "768x768" }],
  })
  expect(await estimate("bfl/flux-3-image", {})).toMatchObject({
    money: { amountNanos: "96000000" },
  })
  expect(await estimate("recraft/recraft-v3", { style: "vector_illustration" })).toMatchObject({
    money: { amountNanos: "160000000" },
  })
  // Mixed quality and size entries cannot be matched safely.
  expect(await estimate("spacexai/grok-imagine-image-2.0", { size: "2K" })).toEqual({
    status: "unpriceable",
    reason: "missing-rate-card",
  })
})

test("reservations cover every image, and refuse what has no bound", async () => {
  const { provider } = gateway(() => Response.json({}))
  const reserve = async (
    modelId: string,
    input: { n?: number; inputImages?: number; size?: string } = {},
    providerOptions?: Record<string, string>
  ) =>
    (
      await provider.image(
        modelId,
        providerOptions && { providerOptions: { gateway: providerOptions } }
      ).resolve!()
    ).costEstimator?.estimateReservation?.({
      n: input.n ?? 2,
      promptTokens: 10,
      inputImages: input.inputImages ?? 0,
      dimensions: input.size ? { size: input.size } : {},
    })

  expect(await reserve("bfl/flux-3-image", { size: "768x768" })).toEqual({
    currency: "USD",
    amountNanos: "82000000",
  })
  expect(await reserve("bfl/flux-3-image", { size: "4096x4096" })).toEqual({
    currency: "USD",
    amountNanos: "96000000",
  })
  expect(await reserve("google/gemini-3.1-flash-lite-image", { n: 1 })).toEqual({
    currency: "USD",
    amountNanos: "40146500",
  })
  expect(await reserve("openai/gpt-image-1-mini")).toBeUndefined()
  expect(await reserve("google/gemini-3.1-flash-lite-image", { inputImages: 1 })).toBeUndefined()
  // Routing overrides may change the tariff.
  expect(await reserve("bfl/flux-3-image", {}, { models: "other" })).toBeUndefined()
})

test("an unresolved binding resolves before its first call", async () => {
  const { provider, requests } = gateway(() =>
    Response.json({ images: [base64(PNG)], providerMetadata: { gateway: { cost: "0.041" } } })
  )
  const result = await provider.image("bfl/flux-3-image").generate(request)
  expect(requests[0]!.url).toBe("https://gateway.test/prefix/v4/ai/image-model")
  expect(result.output.images).toEqual([{ data: PNG, mediaType: "image/png" }])
})

test("unreadable images keep the billable reply's metadata", async () => {
  const { provider } = gateway(() =>
    Response.json({
      images: [base64(new Uint8Array([1, 2, 3]))],
      providerMetadata: { gateway: { cost: "0.041" } },
    })
  )
  const model = await provider.image("bfl/flux-3-image").resolve!()
  await expect(model.generate(request)).rejects.toMatchObject({
    code: "invalid_image_response",
    metadata: { reportedCost: { money: { amountNanos: "41000000" } } },
  })
})

test("a binding's description says when to pick it, over the catalog's", async () => {
  const { provider } = gateway(() => Response.json({}))
  const described = provider.image("bfl/flux-3-image", { description: "Fast drafts" })

  expect(described.definition.description).toBe("Fast drafts")
  expect((await described.resolve!()).definition.description).toBe("Fast drafts")
  expect((await provider.image("bfl/flux-3-image").resolve!()).definition).toMatchObject({
    name: "FLUX.3",
    description: "Black Forest Labs' image model.",
  })
  expect(() => provider.image("bfl/flux-3-image", { description: " " })).toThrow("description")
})
