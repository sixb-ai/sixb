import { expect, test } from "bun:test"
import { EmbeddingModelResponseError } from "@sixb/core/models"
import { vectorConfiguration } from "../../../packages/core/src/objects/vectors/profile"
import { type AzureAIFoundryEmbeddingOptions, createAzureAIFoundry } from "../src"

const project = "https://project.services.ai.azure.com/api/projects/test"
const resource = "https://embedding-resource.openai.azure.com"
const name = "text-embedding-3-small"

function setup(
  options: {
    modelName?: string
    modelVersion?: string
    modelPublisher?: string
    capabilities?: Record<string, string>
    response?: () => Response | Promise<Response>
    catalog?: () => Response | Promise<Response>
    resourceFetch?: (url: string | URL | Request, init?: RequestInit) => Promise<Response>
  } = {}
) {
  const calls: { url: string; init?: RequestInit }[] = []
  let price = 0.02
  let discoveryCount = 0
  const provider = createAzureAIFoundry({
    endpoint: project,
    apiKey: "project-key",
    providerId: "my-foundry",
    fetch: async (url, init) => {
      discoveryCount++
      expect(new Headers(init?.headers).get("api-key")).toBe("project-key")
      expect(String(url)).toBe(`${project}/deployments?api-version=v1`)
      return Response.json({
        value: [
          {
            type: "ModelDeployment",
            name: "products",
            modelName: options.modelName ?? name,
            modelVersion: options.modelVersion ?? "1",
            modelPublisher: options.modelPublisher ?? "OpenAI",
            capabilities: options.capabilities ?? { embeddings: "true" },
            sku: { name: "GlobalStandard" },
          },
        ],
      })
    },
    embeddings: {
      endpoint: resource,
      apiKey: "embedding-key",
      fetch: async (url, init) => {
        calls.push({ url: String(url), init })
        if (options.resourceFetch) return options.resourceFetch(url, init)
        return options.response?.() ?? response()
      },
    },
    catalog: {
      fetch: async () =>
        options.catalog?.() ??
        Response.json({
          azure: {
            models: {
              [name]: {
                id: name,
                family: "text-embedding",
                modalities: { output: ["text"] },
                limit: { output: 1536 },
                cost: { input: price, output: 0 },
              },
            },
          },
        }),
    },
  })
  return {
    provider,
    identity: { name: options.modelName ?? name, version: options.modelVersion ?? "1" },
    calls,
    discoveryCount: () => discoveryCount,
    setPrice: (value: number) => {
      price = value
    },
  }
}

function response(overrides: Record<string, unknown> = {}) {
  return Response.json(
    {
      model: name,
      data: [{ index: 0, embedding: [1, 0] }],
      usage: { prompt_tokens: 12, total_tokens: 12 },
      ...overrides,
    },
    { headers: { "apim-request-id": "azure-request" } }
  )
}

// Regression proof: remove the provider's embedding binding, or send inference through the
// project transport. This fails before returning vectors and accounting evidence.
test("embeddings route to their resource with separate credentials and preserve usage", async () => {
  const f = setup()
  const model = f.provider.embedding("products", { model: f.identity, dimensions: 2 })
  expect(f.discoveryCount()).toBe(0)
  expect(model.definition).toEqual({
    kind: "embedding",
    providerId: "my-foundry",
    modelId: "products",
    dimensions: 2,
    representation: { name, version: "1" },
  })
  const result = await model.embed({ texts: ["running shoes"] })
  expect(result).toMatchObject({
    vectors: [[1, 0]],
    usage: { inputTokens: 12, outputTokens: 0 },
    providerIds: { requestId: "azure-request" },
    responseModelId: name,
  })
  const call = f.calls[0]!
  expect(call.url).toBe(`${resource}/openai/v1/embeddings`)
  expect(new Headers(call.init?.headers).get("api-key")).toBe("embedding-key")
  expect(new Headers(call.init?.headers).get("accept")).toBe("application/json")
  expect(call.init?.redirect).toBe("error")
  expect(JSON.parse(String(call.init?.body))).toEqual({
    model: "products",
    input: ["running shoes"],
    encoding_format: "float",
    dimensions: 2,
  })
})

test("snapshot options and pricing; refresh changes future resolutions only", async () => {
  const f = setup()
  const options = { model: { ...f.identity }, dimensions: 2 }
  const binding = f.provider.embedding("products", options)
  options.dimensions = 3
  options.model.name = "changed"
  options.model.version = "changed"
  const model = await binding.resolve()
  const result = await model.embed({ texts: ["x"] })
  expect(
    model.costEstimator?.estimate({ usage: result.usage!, responseModelId: name })
  ).toMatchObject({ status: "rated" })
  const estimate = () =>
    model.costEstimator?.estimate({ usage: { inputTokens: 1000000, outputTokens: 0 } })
  const initial = estimate()
  f.setPrice(2)
  await f.provider.catalog.refresh()
  expect(estimate()).toEqual(initial)
  const refreshed = await binding.resolve()
  expect(
    refreshed.costEstimator?.estimate({ usage: { inputTokens: 1000000, outputTokens: 0 } })
  ).not.toEqual(initial)
  expect(model.definition.dimensions).toBe(2)
  expect(await model.resolve()).toBe(model)
})

test("embedding catalog entries are neither listed nor executable as language models", async () => {
  const f = setup()
  expect(await f.provider.catalog.list()).toEqual([])
  await expect(f.provider("products").resolve()).rejects.toThrow("foundry.embedding()")
  expect(f.calls).toHaveLength(0)
})

test("reorders indexed results to match input order", async () => {
  const f = setup({
    response: () =>
      response({
        data: [
          { index: 1, embedding: [0, 1] },
          { index: 0, embedding: [1, 0] },
        ],
      }),
  })
  expect(
    (
      await f.provider
        .embedding("products", { model: f.identity, dimensions: 2 })
        .embed({ texts: ["a", "b"] })
    ).vectors
  ).toEqual([
    [1, 0],
    [0, 1],
  ])
})

// Regression proof: replace parseVectors with an unchecked data.map(). Invalid responses
// then succeed instead of preserving accounting metadata on EmbeddingModelResponseError.
test.each(
  [
    [],
    [{ index: 0, embedding: [0, 0] }],
    [{ index: 0, embedding: [1] }],
    [{ index: 1, embedding: [1, 0] }],
    [{ index: 0, embedding: [1e100, 0] }],
    [{ index: 0, embedding: ["1", 0] }],
    [{ index: 0, embedding: [1e-100, 0] }],
  ].map((data) => [data])
)("rejects invalid vectors without losing billing evidence: %j", async (data) => {
  const f = setup({ response: () => response({ data }) })
  try {
    await f.provider
      .embedding("products", { model: f.identity, dimensions: 2 })
      .embed({ texts: ["x"] })
    throw new Error("Expected rejection")
  } catch (error) {
    expect(error).toBeInstanceOf(EmbeddingModelResponseError)
    expect((error as EmbeddingModelResponseError).metadata).toMatchObject({
      usage: { inputTokens: 12 },
      providerIds: { requestId: "azure-request" },
    })
  }
  expect(f.calls).toHaveLength(1)
})

test("duplicate indices and a different response model are rejected", async () => {
  for (const body of [
    {
      data: [
        { index: 0, embedding: [1, 0] },
        { index: 0, embedding: [1, 0] },
      ],
    },
    { model: "different-model" },
  ]) {
    const f = setup({ response: () => response(body) })
    await expect(
      f.provider
        .embedding("products", { model: f.identity, dimensions: 2 })
        .embed({ texts: ["a", "b"] })
    ).rejects.toBeInstanceOf(EmbeddingModelResponseError)
  }
})

test("missing or inconsistent usage is unknown, not zero", async () => {
  for (const usage of [undefined, { prompt_tokens: -1 }, { prompt_tokens: 3, total_tokens: 2 }]) {
    const f = setup({ response: () => response({ usage }) })
    const model = await f.provider
      .embedding("products", { model: f.identity, dimensions: 2 })
      .resolve()
    const result = await model.embed({ texts: ["x"] })
    expect(result.usage?.inputTokens).toBeUndefined()
    expect(model.costEstimator?.estimate({ usage: result.usage! })).toMatchObject({
      status: "unpriceable",
    })
  }
})

test("unexpected usage meters prevent automatic pricing", async () => {
  const f = setup({
    response: () => response({ usage: { prompt_tokens: 12, total_tokens: 12, other_meter: 1 } }),
  })
  const model = await f.provider
    .embedding("products", { model: f.identity, dimensions: 2 })
    .resolve()
  const result = await model.embed({ texts: ["x"] })
  expect(result.usage?.inputTokens).toBe(12)
  expect(model.costEstimator?.estimate({ usage: result.usage! })).toMatchObject({
    status: "unpriceable",
  })
})

test("ada-002 validates its fixed dimensions without sending a dimensions parameter", async () => {
  const f = setup({
    modelName: "text-embedding-ada-002",
    response: () =>
      response({
        model: "text-embedding-ada-002",
        data: [{ index: 0, embedding: Array(1536).fill(1) }],
      }),
  })
  await f.provider
    .embedding("products", { model: f.identity, dimensions: 1536 })
    .embed({ texts: ["x"] })
  expect(JSON.parse(String(f.calls[0]!.init?.body))).not.toHaveProperty("dimensions")
  await expect(
    f.provider.embedding("products", { model: f.identity, dimensions: 2 }).resolve()
  ).rejects.toThrow("1536 dimensions")
})

test("unsupported models and dimensions fail before inference", async () => {
  for (const config of [
    { modelName: "cohere-embed-v3-english", modelPublisher: "Cohere" },
    { modelName: "gpt-5" },
    { capabilities: { embeddings: "false" } },
    {},
  ]) {
    const f = setup(config)
    await expect(
      f.provider.embedding("products", { model: f.identity, dimensions: 1537 }).resolve()
    ).rejects.toThrow()
    expect(f.calls).toHaveLength(0)
  }
})

test("no implicit HTTP retries; provider errors redact resource credentials", async () => {
  const f = setup({
    response: () =>
      Response.json({ error: { message: "embedding-key", code: "busy" } }, { status: 503 }),
  })
  await expect(
    f.provider.embedding("products", { model: f.identity, dimensions: 2 }).embed({ texts: ["x"] })
  ).rejects.toThrow("[REDACTED]")
  expect(f.calls).toHaveLength(1)
})

test("cancellation bounds resource fetch and propagates its signal", async () => {
  const controller = new AbortController()
  let started!: () => void
  const ready = new Promise<void>((resolve) => {
    started = resolve
  })
  const f = setup({
    resourceFetch: async (_url, init) => {
      expect(init?.signal).toBe(controller.signal)
      started()
      return new Promise<Response>(() => {})
    },
  })
  const result = f.provider
    .embedding("products", { model: f.identity, dimensions: 2 })
    .embed({ texts: ["x"], signal: controller.signal })
  await ready
  controller.abort(new Error("stopped"))
  await expect(result).rejects.toThrow("stopped")
  expect(f.calls).toHaveLength(1)
})

test("invalid local inputs and empty batches never perform network calls", async () => {
  const f = setup()
  expect(() => f.provider.embedding("products", { model: f.identity, dimensions: 0 })).toThrow()
  const model = f.provider.embedding("products", { model: f.identity, dimensions: 2 })
  await expect(model.embed({ texts: [" "] })).rejects.toThrow("nonempty")
  await expect(model.embed({ texts: Array(2049).fill("x") })).rejects.toThrow("2048")
  expect(await model.embed({ texts: [] })).toEqual({ vectors: [] })
  expect(f.discoveryCount()).toBe(0)
})

test("explicit pricing can rate a model absent from the public catalog", async () => {
  const f = setup({ catalog: async () => Response.json({ azure: { models: {} } }) })
  const options: AzureAIFoundryEmbeddingOptions = {
    model: f.identity,
    dimensions: 2,
    rateCard: { currency: "USD", unit: "million-tokens", input: "1", output: "0" },
  }
  const model = await f.provider.embedding("products", options).resolve()
  const result = await model.embed({ texts: ["x"] })
  expect(model.costEstimator?.estimate({ usage: result.usage! })).toMatchObject({ status: "rated" })
})

test("resource endpoint and credentials are explicitly required and validated", () => {
  const provider = createAzureAIFoundry({ endpoint: project, apiKey: "project-key" })
  expect(() =>
    provider.embedding("products", { model: { name, version: "1" }, dimensions: 2 })
  ).toThrow("embeddings.endpoint")
  for (const endpoint of [project, `${resource}/other`, `${resource}?key=secret`, "not-a-url"]) {
    expect(() =>
      createAzureAIFoundry({
        endpoint: project,
        apiKey: "key",
        embeddings: { endpoint, apiKey: "resource-key" },
      })
    ).toThrow()
  }
})

test("a successful response with invalid JSON retains its request identifier", async () => {
  const f = setup({
    response: () => new Response("bad json", { headers: { "apim-request-id": "azure-request" } }),
  })
  try {
    await f.provider
      .embedding("products", { model: f.identity, dimensions: 2 })
      .embed({ texts: ["x"] })
    throw new Error("Expected rejection")
  } catch (error) {
    expect(error).toBeInstanceOf(EmbeddingModelResponseError)
    expect((error as EmbeddingModelResponseError).metadata.providerIds?.requestId).toBe(
      "azure-request"
    )
  }
})

test("overflowing JSON numbers in a vector do not discard known usage", async () => {
  const f = setup({
    response: () =>
      new Response(
        `{"model":"${name}","data":[{"index":0,"embedding":[1e400,0]}],"usage":{"prompt_tokens":12,"total_tokens":12}}`
      ),
  })
  try {
    await f.provider
      .embedding("products", { model: f.identity, dimensions: 2 })
      .embed({ texts: ["x"] })
    throw new Error("Expected rejection")
  } catch (error) {
    expect(error).toBeInstanceOf(EmbeddingModelResponseError)
    expect((error as EmbeddingModelResponseError).metadata.usage?.inputTokens).toBe(12)
  }
})

test("missing catalog pricing does not prevent embedding but cannot admit a cost budget", async () => {
  const f = setup({ catalog: async () => Response.json({ azure: { models: {} } }) })
  const model = await f.provider
    .embedding("products", { model: f.identity, dimensions: 2 })
    .resolve()
  expect(
    model.costEstimator?.estimateReservation?.({ inputTokens: 12, outputTokens: 0 })
  ).toBeUndefined()
  const result = await model.embed({ texts: ["x"] })
  expect(result.usage?.inputTokens).toBe(12)
  expect(model.costEstimator?.estimate({ usage: result.usage! })).toMatchObject({
    status: "unpriceable",
  })
})

test("text-embedding-3-large accepts its full output size", async () => {
  const f = setup({
    modelName: "text-embedding-3-large",
    response: () =>
      response({
        model: "text-embedding-3-large",
        data: [{ index: 0, embedding: Array(3072).fill(1) }],
      }),
  })
  expect(
    (
      await f.provider
        .embedding("products", { model: f.identity, dimensions: 3072 })
        .embed({ texts: ["x"] })
    ).vectors[0]
  ).toHaveLength(3072)
})

test("deployment facts reject language calls even without catalog pricing", async () => {
  const f = setup({ catalog: async () => Response.json({ azure: { models: {} } }) })
  await expect(f.provider("products").resolve()).rejects.toThrow("foundry.embedding()")
  expect(await f.provider.catalog.list()).toEqual([])
  expect(f.calls).toHaveLength(0)
})

test("deployment model and version must match the declaration before inference", async () => {
  // Removal proof: omit the discovered identity comparison in resolve(); these calls succeed.
  for (const actual of [{ modelName: "text-embedding-3-large" }, { modelVersion: "2" }]) {
    const f = setup(actual)
    const model = f.provider.embedding("products", { model: { name, version: "1" }, dimensions: 2 })
    await expect(model.embed({ texts: ["x"] })).rejects.toThrow("expected text-embedding-3-small@1")
    expect(f.calls).toHaveLength(0)
  }
})

test("a returned model version cannot contradict the pinned representation", async () => {
  const f = setup({ response: () => response({ model: `${name}-2` }) })
  await expect(
    f.provider.embedding("products", { model: f.identity, dimensions: 2 }).embed({ texts: ["x"] })
  ).rejects.toBeInstanceOf(EmbeddingModelResponseError)
})

test("pins are validated without network access", () => {
  const f = setup()
  for (const model of [
    { name: "", version: "1" },
    { name, version: " " },
  ]) {
    expect(() => f.provider.embedding("products", { model, dimensions: 2 })).toThrow(
      "expected model name and version"
    )
  }
  expect(f.discoveryCount()).toBe(0)
})

test("deployment aliases get distinct profile fingerprints for different model pins", async () => {
  const small = setup().provider.embedding("products", {
    model: { name, version: "1" },
    dimensions: 2,
  })
  const large = setup({ modelName: "text-embedding-3-large" }).provider.embedding("products", {
    model: { name: "text-embedding-3-large", version: "1" },
    dimensions: 2,
  })
  const fingerprint = (model: typeof small) => vectorConfiguration({ source: ["text"], model })
  expect(fingerprint(small)).not.toBe(fingerprint(large))
  expect(fingerprint(await small.resolve())).toBe(fingerprint(small))
  expect(fingerprint(await large.resolve())).toBe(fingerprint(large))
})
