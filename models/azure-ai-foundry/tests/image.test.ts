import { describe, expect, test } from "bun:test"
import {
  InMemoryBlobStorage,
  InMemoryBroker,
  InMemoryLakeStorage,
  InMemoryQueues,
  InMemoryStorage,
  SixbHost,
} from "@sixb/core"
import {
  ImageModelResponseError,
  ModelProviderError,
  UnsupportedModelFeatureError,
} from "@sixb/core/models"
import { createTestSixb } from "@sixb/core/testing"
import { type AzureAIFoundryOptions, createAzureAIFoundry } from "../src"

const endpoint = "https://resource.services.ai.azure.com/api/projects/test"
const deploymentUrl = (name: string, operation: string) =>
  `https://resource.services.ai.azure.com/openai/deployments/${name}/images/${operation}?api-version=2025-04-01-preview`

// The records Azure's project discovery returned for image deployments: no image flag.
const gptDeployment = {
  type: "ModelDeployment",
  name: "image",
  modelName: "gpt-image-1.5",
  modelVersion: "2025-12-16",
  modelPublisher: "OpenAI",
  capabilities: {},
  sku: { name: "GlobalStandard", capacity: 3 },
}
const kontextDeployment = {
  type: "ModelDeployment",
  name: "kontext",
  modelName: "FLUX.1-Kontext-pro",
  modelVersion: "1",
  modelPublisher: "Black Forest Labs",
  capabilities: {},
  sku: { name: "GlobalStandard", capacity: 3 },
}
const flux2Deployment = { ...kontextDeployment, name: "flux-2", modelName: "FLUX.2-pro" }
const chatDeployment = {
  type: "ModelDeployment",
  name: "chat",
  modelName: "future-chat",
  modelVersion: "1",
  modelPublisher: "Fixture",
  capabilities: { chat_completion: "true" },
  sku: { name: "GlobalStandard" },
}

const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])
const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2])
const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64")

// Azure's reply for gpt-image-1.5 at low quality: text output tokens beside the image's.
const gptReply = {
  created: 1,
  data: [{ b64_json: b64(png) }],
  output_format: "png",
  usage: {
    input_tokens: 1_000_000,
    input_tokens_details: { image_tokens: 0, text_tokens: 1_000_000 },
    output_tokens: 2_000_000,
    output_tokens_details: { image_tokens: 1_000_000, text_tokens: 1_000_000 },
    total_tokens: 3_000_000,
  },
}
// FLUX reports no usage.
const fluxReply = { created: 1, data: [{ url: null, b64_json: b64(jpeg) }] }

type Fetch = NonNullable<AzureAIFoundryOptions["fetch"]>

/** Discovery answers from `deployments`; every other request goes to `inference`. */
function foundry(
  inference: Fetch,
  options: Partial<AzureAIFoundryOptions> & { deployments?: unknown[] } = {}
) {
  const calls: string[] = []
  const provider = createAzureAIFoundry({
    endpoint,
    apiKey: "secret-key",
    catalog: { fetch: async () => Response.json({ azure: { models: {} } }) },
    ...options,
    fetch: async (url, init) => {
      calls.push(new URL(String(url)).pathname)
      if (new URL(String(url)).pathname.endsWith("/deployments"))
        return Response.json({
          value: options.deployments ?? [
            gptDeployment,
            kontextDeployment,
            flux2Deployment,
            chatDeployment,
          ],
        })
      return inference(url, init)
    },
  })
  return { provider, calls }
}

describe("foundry.image()", () => {
  test("GPT Image generates through the deployment's images route and prices its tokens", async () => {
    let request: { url: string; headers: Headers; body: unknown } | undefined
    const { provider, calls } = foundry(async (url, init) => {
      request = {
        url: String(url),
        headers: new Headers(init?.headers),
        body: JSON.parse(String(init?.body)),
      }
      return Response.json(gptReply, { headers: { "apim-request-id": "request-1" } })
    })
    const binding = provider.image("image", { description: "Product shots" })
    expect(calls).toEqual([])
    expect(binding.definition).toEqual({
      kind: "image",
      providerId: "azure-ai-foundry",
      modelId: "image",
      via: "Azure AI Foundry",
      description: "Product shots",
      inputImages: {
        maxCount: 16,
        maxBytes: 50 * 1024 * 1024,
        mediaTypes: ["image/png", "image/jpeg", "image/webp"],
      },
    })

    const model = await binding.resolve()
    expect(model.definition).toMatchObject({
      publisher: { id: "openai", name: "OpenAI" },
      maxImagesPerCall: 10,
      sizes: ["auto", "1024x1024", "1536x1024", "1024x1536"],
      qualities: ["auto", "low", "medium", "high"],
      inputImages: { maxCount: 16 },
    })
    const result = await model.generate({
      prompt: "A red cube",
      n: 1,
      size: "1024x1024",
      quality: "low",
      images: [],
    })

    expect(request?.url).toBe(deploymentUrl("image", "generations"))
    expect(request?.headers.get("api-key")).toBe("secret-key")
    expect(request?.headers.get("accept")).toBe("application/json")
    // One image is the default and is not sent.
    expect(request?.body).toEqual({ prompt: "A red cube", size: "1024x1024", quality: "low" })
    expect(result).toEqual({
      output: { images: [{ data: png, mediaType: "image/png" }] },
      usage: {
        outputImages: 1,
        inputTokens: 1_000_000,
        outputTokens: 2_000_000,
        imageOutputTokens: 1_000_000,
        textOutputTokens: 1_000_000,
        raw: gptReply.usage,
      },
      providerIds: { requestId: "request-1" },
    })
    expect(model.rateCard).toEqual({ currency: "USD", input: "5", output: "10", imageOutput: "32" })
    // USD 5 per million text input, 10 per million text output, 32 per million image output.
    expect(model.costEstimator?.estimate({ usage: result.usage! })).toMatchObject({
      status: "rated",
      money: { currency: "USD", amountNanos: "47000000000" },
    })
    // Token-priced output has no bound before the call.
    expect(
      model.costEstimator?.estimateReservation?.({
        n: 1,
        promptTokens: 3,
        inputImages: 0,
        dimensions: {},
      })
    ).toBeUndefined()
  })

  test("a GPT Image edit uploads its references; image input tokens leave it unpriced", async () => {
    let request: { url: string; form: FormData } | undefined
    const { provider } = foundry(async (url, init) => {
      request = { url: String(url), form: init?.body as FormData }
      return Response.json({
        ...gptReply,
        usage: {
          ...gptReply.usage,
          input_tokens_details: { image_tokens: 194, text_tokens: 26 },
        },
      })
    })
    const model = await provider.image("image").resolve()
    const result = await model.generate({
      prompt: "Make it blue",
      n: 2,
      images: [
        { data: png, mediaType: "image/png" },
        { data: jpeg, mediaType: "image/jpeg" },
      ],
    })

    expect(request?.url).toBe(deploymentUrl("image", "edits"))
    expect(request?.form.get("prompt")).toBe("Make it blue")
    expect(request?.form.get("n")).toBe("2")
    const files = request?.form.getAll("image[]") as File[]
    expect(files.map((file) => file.name)).toEqual(["image-0.png", "image-1.jpg"])
    expect(new Uint8Array(await files[1]!.arrayBuffer())).toEqual(jpeg)
    // Removal proof: drop the image_tokens check in imageEstimator(); the edit is rated.
    expect(model.costEstimator?.estimate({ usage: result.usage! }).status).toBe("unpriceable")
  })

  test("FLUX.1 Kontext returns one image, priced per image, and edits one reference", async () => {
    const requests: { url: string; body: unknown }[] = []
    const { provider } = foundry(async (url, init) => {
      requests.push({ url: String(url), body: init?.body })
      return Response.json(fluxReply)
    })
    const model = await provider.image("kontext").resolve()
    expect(model.definition).toMatchObject({
      publisher: { id: "black-forest-labs", name: "Black Forest Labs" },
      maxImagesPerCall: 1,
      inputImages: { maxCount: 1 },
    })
    expect(model.definition).not.toHaveProperty("qualities")

    const result = await model.generate({
      prompt: "A red cube",
      n: 1,
      quality: "low",
      seed: 7,
      style: "vivid",
      aspectRatio: "16:9",
      images: [],
    })
    expect(JSON.parse(String(requests[0]?.body))).toEqual({ prompt: "A red cube" })
    expect(result.output.images).toEqual([{ data: jpeg, mediaType: "image/jpeg" }])
    expect(result.usage).toEqual({ outputImages: 1 })
    expect(result.warnings).toEqual([
      "seed: not supported",
      "style: not supported",
      "aspectRatio: not supported; use size",
      "quality: not supported",
    ])
    expect(model.rateCard).toEqual({ currency: "USD", images: "0.04" })
    expect(model.costEstimator?.estimate({ usage: result.usage! })).toMatchObject({
      status: "rated",
      money: { amountNanos: "40000000" },
    })
    expect(
      model.costEstimator?.estimateReservation?.({
        n: 1,
        promptTokens: 3,
        inputImages: 1,
        dimensions: {},
      })
    ).toEqual({ currency: "USD", amountNanos: "40000000" })

    await model.generate({ prompt: "Blue", n: 1, images: [{ data: png, mediaType: "image/png" }] })
    expect(requests[1]?.url).toBe(deploymentUrl("kontext", "edits"))
    const form = requests[1]?.body as FormData
    // Kontext takes one `image`, and rejects even `n=1` in its edit form.
    expect((form.get("image") as File).name).toBe("image-0.png")
    expect(form.has("n")).toBe(false)

    const many = await model.generate({ prompt: "x", n: 2, images: [] }).catch((e: unknown) => e)
    expect(String(many)).toContain("at most 1 per call")
    const two = await model
      .generate({
        prompt: "x",
        n: 1,
        images: [
          { data: png, mediaType: "image/png" },
          { data: png, mediaType: "image/png" },
        ],
      })
      .catch((e: unknown) => e)
    expect(String(two)).toContain("at most 1 reference images")
    expect(requests).toHaveLength(2)
  })

  test("prices only published models, versions and SKUs", async () => {
    const usage = { outputImages: 1, inputTokens: 10, outputTokens: 10, imageOutputTokens: 10 }
    const price = async (deployment: object) => {
      const { provider } = foundry(async () => Response.json(gptReply), {
        deployments: [{ ...gptDeployment, ...deployment }],
      })
      const model = await provider.image("image").resolve()
      return model.costEstimator?.estimate({ usage: { ...usage, textOutputTokens: 0 } }).status
    }
    expect(await price({})).toBe("rated")
    expect(await price({ sku: { name: "DataZoneStandard" } })).toBe("rated")
    expect(await price({ modelName: "gpt-image-1", modelVersion: "2025-04-15" })).toBe("rated")
    expect(await price({ modelName: "gpt-image-2", modelVersion: "2026-04-21" })).toBe("rated")
    expect(await price({ modelVersion: "2027-01-01" })).toBeUndefined()
    expect(await price({ modelName: "gpt-image-2.5-flare", modelVersion: "2026-09-08" })).toBe(
      undefined
    )

    // gpt-image-1 reports no output split: without a text price, all output bills at the image
    // rate. Removal proof: give gpt() an imageOutput for every model; this becomes unpriceable.
    const one = await foundry(
      async () =>
        Response.json({
          ...gptReply,
          usage: {
            input_tokens: 1_000_000,
            input_tokens_details: { image_tokens: 0, text_tokens: 1_000_000 },
            output_tokens: 1_000_000,
            total_tokens: 2_000_000,
          },
        }),
      { deployments: [{ ...gptDeployment, modelName: "gpt-image-1", modelVersion: "2025-04-15" }] }
    )
      .provider.image("image")
      .resolve()
    expect(one.rateCard).toEqual({ currency: "USD", input: "5", output: "40" })
    const generated = await one.generate({ prompt: "x", n: 1, images: [] })
    expect(one.costEstimator?.estimate({ usage: generated.usage! })).toMatchObject({
      status: "rated",
      money: { amountNanos: "45000000000" },
    })

    // gpt-image-2 has no text output price: text tokens are not billed at the image rate.
    const two = await foundry(async () => Response.json(gptReply), {
      deployments: [{ ...gptDeployment, modelName: "gpt-image-2", modelVersion: "2026-04-21" }],
    })
      .provider.image("image")
      .resolve()
    expect(
      two.costEstimator?.estimate({ usage: { ...usage, outputTokens: 15, textOutputTokens: 5 } })
        .status
    ).toBe("unpriceable")
  })

  test("keeps image and language deployments apart; FLUX.2 is refused with the reason", async () => {
    const { provider } = foundry(async () => {
      throw new Error("unexpected inference")
    })
    const notImage = await provider
      .image("chat")
      .resolve()
      .catch((error: unknown) => error)
    expect(notImage).toBeInstanceOf(UnsupportedModelFeatureError)
    expect(String(notImage)).toContain("runs future-chat, not an image model")
    const flux2 = await provider
      .image("flux-2")
      .resolve()
      .catch((error: unknown) => error)
    expect(flux2).toBeInstanceOf(UnsupportedModelFeatureError)
    expect(String(flux2)).toContain("FLUX.2-pro is not supported")
    const dalle = await foundry(async () => Response.json(gptReply), {
      deployments: [
        { ...gptDeployment, name: "dalle", modelName: "dall-e-3", modelVersion: "3.0" },
      ],
    })
      .provider.image("dalle")
      .resolve()
      .catch((error: unknown) => error)
    expect(String(dalle)).toContain("dall-e-3 is not supported")
    for (const name of ["image", "kontext", "flux-2"]) {
      const asChat = await provider
        .chat(name)
        .resolve()
        .catch((error: unknown) => error)
      expect(String(asChat)).toContain("Use foundry.image()")
    }
    expect((await provider.catalog.list()).map((d) => d.modelId)).toEqual(["chat"])

    const connected = foundry(async () => Response.json(gptReply), {
      deployments: [{ ...gptDeployment, connectionName: "other-resource" }],
    }).provider
    const viaConnection = await connected
      .image("image")
      .resolve()
      .catch((e: unknown) => e)
    expect(String(viaConnection)).toContain("project connection")
    expect(() => provider.image(" image")).toThrow("deploymentName")
    expect(() => provider.image("image", { description: " " })).toThrow("description")
    expect(() => provider.image("image", { timeoutMs: 0 })).toThrow("timeoutMs")
  })
})

describe("image errors", () => {
  test("a rejection keeps Azure's message and code; throttling is not replayed", async () => {
    // Removal proof: drop "image" from ONE_SHOT in transport.ts; the 429 is posted thrice.
    let posts = 0
    const { provider } = foundry(
      async () => {
        posts++
        return posts === 1
          ? Response.json(
              {
                error: {
                  code: "unsupported_request_value",
                  message:
                    "Model does not support request parameter value supplied: 'n' must be a positive integer.",
                },
              },
              { status: 400 }
            )
          : new Response(null, { status: 429, headers: { "retry-after-ms": "0" } })
      },
      { maxRetries: 2 }
    )
    const model = await provider.image("image").resolve()
    const rejected = await model
      .generate({ prompt: "x", n: 1, images: [] })
      .catch((e: unknown) => e)
    expect(rejected).toBeInstanceOf(ModelProviderError)
    expect(rejected).toMatchObject({
      status: 400,
      code: "unsupported_request_value",
      retryable: false,
    })
    const throttled = await model
      .generate({ prompt: "x", n: 1, images: [] })
      .catch((e: unknown) => e)
    expect(throttled).toMatchObject({ status: 429, retryable: true })
    expect(posts).toBe(2)
  })

  test("an unreadable FLUX image still counts as billed", async () => {
    // Removal proof: count decoded images instead of returned ones; the cost becomes unknown.
    const model = await foundry(async () =>
      Response.json({ data: [{ b64_json: b64(new Uint8Array([1, 2, 3])) }] })
    )
      .provider.image("kontext")
      .resolve()
    const error = await model.generate({ prompt: "x", n: 1, images: [] }).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(ImageModelResponseError)
    const metadata = (error as ImageModelResponseError).metadata
    expect(metadata.usage).toEqual({ outputImages: 1 })
    expect(model.costEstimator?.estimate({ usage: metadata.usage! }).status).toBe("rated")
  })

  test("a reply without readable images keeps its usage", async () => {
    for (const data of [
      [],
      [{ url: "https://example.com/a.png" }],
      [{ b64_json: b64(new Uint8Array([1, 2])) }],
    ]) {
      const model = await foundry(async () => Response.json({ ...gptReply, data }))
        .provider.image("image")
        .resolve()
      const error = await model.generate({ prompt: "x", n: 1, images: [] }).catch((e: unknown) => e)
      expect(error).toBeInstanceOf(ImageModelResponseError)
      expect(error).toMatchObject({ metadata: { usage: { inputTokens: 1_000_000 } } })
    }
    const invalid = await foundry(async () => new Response("{"))
      .provider.image("image")
      .resolve()
    expect(
      await invalid.generate({ prompt: "x", n: 1, images: [] }).catch((e: unknown) => e)
    ).toBeInstanceOf(ImageModelResponseError)
  })

  test("the timeout and the caller's signal both reach the transport", async () => {
    const hang: Fetch = (_, init) =>
      new Promise((_, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal!.reason), { once: true })
      })
    const { provider } = foundry(hang)
    const timed = await provider.image("image", { timeoutMs: 5 }).resolve()
    expect(
      await timed.generate({ prompt: "x", n: 1, images: [] }).catch((e: unknown) => e)
    ).toMatchObject({ name: "TimeoutError" })
    const controller = new AbortController()
    const model = await provider.image("image").resolve()
    const pending = model
      .generate({ prompt: "x", n: 1, images: [], signal: controller.signal })
      .catch((e: unknown) => e)
    controller.abort(new Error("cancelled"))
    expect(await pending).toMatchObject({ message: "cancelled" })
  })
})

describe("in a project", () => {
  test("sixb.models.image.generate() stores the images and records usage and cost", async () => {
    const { provider } = foundry(async () => Response.json(fluxReply))
    const project = new SixbHost({
      id: "foundry-image",
      ontology: [],
      models: { image: [provider.image("kontext")] },
      storage: new InMemoryStorage(),
      broker: new InMemoryBroker(),
      queues: new InMemoryQueues(),
      blobStorage: new InMemoryBlobStorage(),
      lakeStorage: new InMemoryLakeStorage(),
    })
    const sixb = createTestSixb(project)
    const result = await sixb.models.image.generate({ prompt: "A red cube" })

    expect(result.files).toMatchObject([{ mediaType: "image/jpeg", sizeBytes: jpeg.length }])
    expect(result.cost).toMatchObject({ status: "rated", money: { amountNanos: "40000000" } })
    expect(
      await project.storage.aiUsage!.getLatestForExecution({
        projectId: project.id,
        executionId: sixb.execution.id,
      })
    ).toMatchObject({ callId: result.callId, modelKind: "image", requestedModelId: "kontext" })
  })
})
