import { describe, expect, test } from "bun:test"
import { SixbHost } from "../src"
import { emptyGrantIndex } from "../src/authorization"
import { bindRequestExecution } from "../src/execution/request"
import {
  createModelCatalog,
  defineModelRateCard,
  type ImageModel,
  ImageModelResponseError,
  rateModelCall,
} from "../src/models"
import { createTestRuntimeDeps } from "./test-runtime-deps"

const PNG = new Uint8Array([137, 80, 78, 71, 1])
const JPEG = new Uint8Array([255, 216, 255, 2])

function createImageModel(
  generate: ImageModel["generate"] = async () => ({
    output: {
      images: [
        { data: PNG, mediaType: "image/png" },
        { data: JPEG, mediaType: "image/jpeg" },
      ],
    },
    reportedCost: { money: { currency: "USD", amountNanos: "16000000" } },
  }),
  definition: Partial<ImageModel["definition"]> = {}
): ImageModel {
  return {
    providerId: "test",
    modelId: "painter",
    definition: {
      kind: "image",
      providerId: "test",
      modelId: "painter",
      maxImagesPerCall: 4,
      sizes: ["768x768", "1024x1024"],
      inputImages: { maxCount: 1, maxBytes: 1024, mediaTypes: ["image/png"] },
      ...definition,
    },
    generate,
  }
}

async function setup(model = createImageModel()) {
  const deps = createTestRuntimeDeps()
  const host = new SixbHost({
    id: "images",
    ontology: [],
    ...deps,
    models: { image: [model] },
  })
  const controller = new AbortController()
  const sixb = bindRequestExecution(host, {
    request: new Request("http://localhost/images", { signal: controller.signal }),
    authorization: { type: "disabled" },
  })
  const reference = await deps.blobStorage.put({ body: PNG, mediaType: "image/png" })
  return {
    ...deps,
    host,
    sixb,
    reference,
    controller,
    identity: { projectId: host.id, executionId: sixb.execution.id },
  }
}

async function bytes(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

describe("image generation", () => {
  // Removal proof: remove assertModelAccess from the image runtime; the protected call succeeds.
  test("denies principal-scoped calls before reading files or invoking a provider", async () => {
    let calls = 0
    const { host, reference, blobStorage } = await setup(
      createImageModel(async () => {
        calls++
        return { output: { images: [{ data: PNG, mediaType: "image/png" }] } }
      })
    )
    let reads = 0
    const stat = blobStorage.stat.bind(blobStorage)
    blobStorage.stat = async (id) => {
      reads++
      return stat(id)
    }
    const scoped = bindRequestExecution(host, {
      request: new Request("http://localhost/images"),
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

    await expect(
      scoped.models.image.generate({ prompt: "a fox", images: [reference] })
    ).rejects.toThrow("not allowed to call the project's models")
    expect({ reads, calls }).toEqual({ reads: 0, calls: 0 })
  })

  // Removal proof: drop the run:models branch from assertModelAccess; the granted call is refused.
  test("a principal with can.run(project.models) generates as itself", async () => {
    const { host, storage } = await setup()
    await storage.auth.users.create({ projectId: host.id, id: "user", email: "user@example.test" })
    const scoped = bindRequestExecution(host, {
      request: new Request("http://localhost/images"),
      authorization: {
        type: "principal",
        context: {
          principal: { type: "user", id: "user" },
          groupIds: [],
          roleIds: [],
          grants: { ...emptyGrantIndex(), "run:models": true },
        },
      },
    })

    const result = await scoped.models.image.generate({ prompt: "a fox" })
    expect(result.files).toHaveLength(2)
    expect(await scoped.models.calls.files(result.callId)).toMatchObject({ files: result.files })
  })

  // Removal proof: omit onModelCallEnd in image/runtime.ts; the durable-usage assertion fails.
  // Removal proof: omit recordFiles in image/runtime.ts; the call's files are not found.
  test("stores generated images and records the call by images returned", async () => {
    const { sixb, blobStorage, storage, identity } = await setup()

    const result = await sixb.models.image.generate({ prompt: "a fox", n: 2 })

    expect(result.files.map((file) => file.mediaType)).toEqual(["image/png", "image/jpeg"])
    expect(await bytes(await blobStorage.open(result.files[0]!.blobId))).toEqual(PNG)
    expect(await bytes(await blobStorage.open(result.files[1]!.blobId))).toEqual(JPEG)
    expect(result.usage).toEqual({ outputImages: 2 })
    expect(result.cost).toMatchObject({ status: "reported", money: { amountNanos: "16000000" } })
    expect(result.warnings).toEqual([])
    expect(await storage.aiUsage.getLatestForExecution(identity)).toMatchObject({
      modelKind: "image",
      callId: result.callId,
      usage: { outputImages: 2, reportingStatus: "partial" },
    })
    expect(
      await storage.aiUsage.getModelCallFiles({
        projectId: identity.projectId,
        callId: result.callId,
      })
    ).toMatchObject({ executionId: identity.executionId, files: result.files })
  })

  // Removal proof: drop `dimensions` from estimateModelCall in image/runtime.ts; the card has no
  // default price, so the call becomes unpriceable.
  test("prices a call by the size it requested", async () => {
    const rateCard = defineModelRateCard({
      currency: "USD",
      images: {
        variants: [
          { size: "768x768", price: "0.008" },
          { size: "1024x1024", price: "0.009" },
        ],
      },
    })
    const { sixb } = await setup({
      ...createImageModel(async () => ({
        output: { images: [{ data: PNG, mediaType: "image/png" }] },
        usage: { outputImages: 5 },
      })),
      costEstimator: {
        estimate: ({ usage, dimensions }) => rateModelCall({ usage, rateCard, dimensions }),
      },
    })

    const result = await sixb.models.image.generate({ prompt: "a fox", size: "768x768" })

    expect(result.usage).toEqual({ outputImages: 1 })
    expect(result.cost).toMatchObject({
      status: "rated",
      money: { amountNanos: "8000000" },
      components: [{ meter: "images.output", quantity: "1", variant: "768x768" }],
    })
  })

  test("passes verified reference images to the provider", async () => {
    let received: unknown
    const { sixb, reference } = await setup(
      createImageModel(async (request) => {
        received = request.images
        return { output: { images: [{ data: JPEG, mediaType: "image/jpeg" }] } }
      })
    )

    await sixb.models.image.generate({ prompt: "make it blue", images: [reference] })

    expect(received).toEqual([{ data: PNG, mediaType: "image/png" }])
  })

  test("uses the configured binding and validates catalog shape", async () => {
    const { sixb } = await setup()
    const impostor = createImageModel(async () => {
      throw new Error("impostor")
    })

    expect(
      (await sixb.models.image.generate({ prompt: "a fox", model: impostor })).files
    ).toHaveLength(2)
    await expect(
      sixb.models.image.generate({ prompt: "a fox", model: { ...impostor, modelId: "other" } })
    ).rejects.toThrow("Configure")
    expect(() => createModelCatalog({ image: [] })).toThrow("at least one")
    expect(() =>
      createModelCatalog({ image: [createImageModel(undefined, { maxImagesPerCall: 0 })] })
    ).toThrow("maxImagesPerCall")
  })

  test("rejects requests the model cannot serve before inference", async () => {
    let calls = 0
    const { sixb, reference } = await setup(
      createImageModel(async () => {
        calls++
        return { output: { images: [] } }
      })
    )
    const jpeg = { ...reference, mediaType: "image/jpeg" }

    for (const [input, message] of [
      [{ prompt: " " }, "nonblank prompt"],
      [{ prompt: "a fox", n: 5 }, "at most 4 images"],
      [{ prompt: "a fox", size: "4096x4096" }, "not supported"],
      [{ prompt: "a fox", images: [reference, reference] }, "at most 1 reference"],
      [{ prompt: "a fox", images: [jpeg] }, "not supported"],
      [{ prompt: "a fox", images: [{ ...reference, sizeBytes: 2048 }] }, "input limit"],
      [{ prompt: "a fox", images: [{ ...reference, mediaType: "text/plain" }] }, "mediaType"],
    ] as const) {
      await expect(sixb.models.image.generate(input)).rejects.toThrow(message)
    }
    expect(calls).toBe(0)

    const textOnly = await setup(createImageModel(undefined, { inputImages: undefined }))
    await expect(
      textOnly.sixb.models.image.generate({ prompt: "a fox", images: [textOnly.reference] })
    ).rejects.toThrow("does not accept reference images")
  })

  test("records invalid replies once and never retries inference", async () => {
    let calls = 0
    const { sixb, storage, identity } = await setup(
      createImageModel(async () => {
        calls++
        return {
          output: { images: [{ data: new Uint8Array(), mediaType: "image/png" }] },
          reportedCost: { money: { currency: "USD", amountNanos: "5000" } },
        }
      })
    )

    await expect(sixb.models.image.generate({ prompt: "a fox" })).rejects.toBeInstanceOf(
      ImageModelResponseError
    )
    expect(calls).toBe(1)
    expect(await storage.aiUsage.getLatestForExecution(identity)).toMatchObject({
      usage: { outputImages: 1 },
    })
    expect(
      await storage.aiCosts.summarizeExecutions({
        ...identity,
        executionIds: [identity.executionId],
      })
    ).toMatchObject([{ amounts: [{ currency: "USD", amountNanos: "5000" }] }])
  })

  test("accounts for a late billable reply after cancellation", async () => {
    const { sixb, controller, storage, identity, blobStorage } = await setup(
      createImageModel(async () => {
        controller.abort()
        return { output: { images: [{ data: PNG, mediaType: "image/png" }] } }
      })
    )
    let writes = 0
    const put = blobStorage.put.bind(blobStorage)
    blobStorage.put = async (input) => {
      writes++
      return put(input)
    }

    await expect(sixb.models.image.generate({ prompt: "a fox" })).rejects.toThrow()
    expect(writes).toBe(0)
    expect(await storage.aiUsage.getLatestForExecution(identity)).toMatchObject({
      modelKind: "image",
      usage: { outputImages: 1 },
    })
  })

  test("an unknown cost estimate fails closed before inference", async () => {
    let calls = 0
    const { sixb, storage } = await setup(
      createImageModel(async () => {
        calls++
        return { output: { images: [{ data: PNG, mediaType: "image/png" }] } }
      })
    )
    await storage.aiLimits.createPolicy({
      id: "limit",
      projectId: "images",
      subject: { type: "project" },
      limit: {
        meter: "cost.catalogEstimated",
        amount: { currency: "USD", amountNanos: "1000000000" },
      },
    })
    await expect(sixb.models.image.generate({ prompt: "a fox" })).rejects.toMatchObject({
      code: "ai.usage_limit_unavailable",
    })
    expect(calls).toBe(0)
  })

  // Removal proof: drop reservationCost from the image admission; the cost limit refuses the call.
  test("reserves the binding's estimate under a cost limit", async () => {
    let reservation: unknown
    const { sixb, storage } = await setup({
      ...createImageModel(),
      costEstimator: {
        estimateReservation: (input) => {
          reservation = input
          return { currency: "USD", amountNanos: "18000000" }
        },
        estimate: () => ({ status: "unpriceable", reason: "missing-rate-card" }),
      },
    })
    await storage.aiLimits.createPolicy({
      id: "cost",
      projectId: "images",
      subject: { type: "project" },
      limit: {
        meter: "cost.catalogEstimated",
        amount: { currency: "USD", amountNanos: "1000000000" },
      },
    })

    await sixb.models.image.generate({ prompt: "a red fox", n: 2, size: "1024x1024" })

    expect(reservation).toEqual({
      n: 2,
      promptTokens: 3,
      inputImages: 0,
      dimensions: { size: "1024x1024" },
    })
  })
})
