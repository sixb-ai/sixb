import { describe, expect, test } from "bun:test"
import { SixbHost } from "../src"
import { emptyGrantIndex } from "../src/authorization"
import { bindRequestExecution } from "../src/execution/request"
import {
  createModelCatalog,
  type ModelCostEstimate,
  type TranscriptionModel,
  TranscriptionModelResponseError,
} from "../src/models"
import { createTestRuntimeDeps } from "./test-runtime-deps"

function createTranscriber(
  transcribe: TranscriptionModel["transcribe"] = async () => ({
    output: { text: "Hello" },
    usage: { audioDurationMs: 1250 },
    reportedCost: { money: { currency: "USD", amountNanos: "150000" } },
  })
): TranscriptionModel {
  return {
    providerId: "test",
    modelId: "transcriber",
    definition: {
      kind: "transcription",
      providerId: "test",
      modelId: "transcriber",
      maxInputBytes: 1024,
      mediaTypes: ["audio/wav"],
    },
    transcribe,
  }
}

async function setup(model = createTranscriber()) {
  const deps = createTestRuntimeDeps()
  const host = new SixbHost({
    id: "audio",
    ontology: [],
    ...deps,
    models: { audio: { transcription: [model] } },
  })
  const controller = new AbortController()
  const sixb = bindRequestExecution(host, {
    request: new Request("http://localhost/transcribe", { signal: controller.signal }),
    authorization: { type: "disabled" },
  })
  const audio = await deps.blobStorage.put({
    body: new Uint8Array([1, 2, 3]),
    mediaType: "audio/wav",
  })
  return {
    ...deps,
    host,
    sixb,
    audio,
    controller,
    identity: { projectId: host.id, executionId: sixb.execution.id },
  }
}

describe("audio transcription", () => {
  // Removal proof: remove assertModelAccess from the audio runtime; the protected call succeeds.
  test("denies principal-scoped calls before reading files or invoking a provider", async () => {
    const { host, audio, blobStorage } = await setup()
    let reads = 0
    const stat = blobStorage.stat.bind(blobStorage)
    blobStorage.stat = async (id) => {
      reads++
      return stat(id)
    }
    const scoped = bindRequestExecution(host, {
      request: new Request("http://localhost/audio"),
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

    await expect(scoped.models.audio.transcribe({ audio })).rejects.toThrow(
      "not allowed to call the project's models"
    )
    expect(reads).toBe(0)
  })

  // Removal proof: return true from canAccessModels; the ungranted principal can run.
  test("canRun answers what a call enforces", async () => {
    const { host, sixb } = await setup()
    const principal = (grants: ReturnType<typeof emptyGrantIndex>) =>
      bindRequestExecution(host, {
        request: new Request("http://localhost/models"),
        authorization: {
          type: "principal",
          context: {
            principal: { type: "user", id: "user" },
            groupIds: [],
            roleIds: [],
            grants,
          },
        },
      })

    expect(sixb.models.canRun()).toBe(true)
    expect(principal(emptyGrantIndex()).models.canRun()).toBe(false)
    expect(principal({ ...emptyGrantIndex(), "run:models": true }).models.canRun()).toBe(true)
  })

  test("does not accept a different identity after model resolution", async () => {
    const selected = createTranscriber()
    const { sixb, audio } = await setup({
      ...selected,
      resolve: async () => ({
        ...selected,
        modelId: "different",
        definition: { ...selected.definition, modelId: "different" },
      }),
    })

    await expect(sixb.models.audio.transcribe({ audio })).rejects.toThrow("identity does not match")
  })

  // Removal proof: omit onModelCallEnd in audio/runtime.ts; the durable-usage assertion fails.
  test("audio-only projects persist duration, kind and reported cost without inventing tokens", async () => {
    const { sixb, audio, storage, identity } = await setup()

    const result = await sixb.models.audio.transcribe({ audio })

    expect(result.output).toEqual({ text: "Hello" })
    expect(result.usage).toEqual({ audioDurationMs: 1250 })
    expect(result.cost).toMatchObject({ status: "reported", money: { amountNanos: "150000" } })
    const record = await storage.aiUsage.getLatestForExecution(identity)
    expect(record).toMatchObject({
      modelKind: "transcription",
      callId: result.callId,
      usage: { audioDurationMs: 1250, reportingStatus: "partial" },
    })
    expect(record?.usage.totalTokens).toBeUndefined()

    const overview = await storage.aiCosts.queryProjectOverview({
      projectId: "audio",
      from: new Date(Date.now() - 60000),
      to: new Date(Date.now() + 60000),
      bucket: "day",
    })
    expect(overview.totals.usage.audioDurationMs).toBe(1250)
    expect(overview.totals.usageCoverage.fieldCallCounts.audioDurationMs).toBe(1)
  })

  // Removal proof: drop the `data` branch of prepareAudio; the bytes are rejected as a FileRef.
  test("transcribes audio bytes without storing them", async () => {
    let received: { audio: Uint8Array; mediaType: string } | undefined
    const { sixb, blobStorage, storage, identity } = await setup(
      createTranscriber(async (request) => {
        received = { audio: request.audio, mediaType: request.mediaType }
        return { output: { text: "Hello" }, usage: { audioDurationMs: 900 } }
      })
    )
    const put = blobStorage.put.bind(blobStorage)
    let writes = 0
    blobStorage.put = async (input) => {
      writes++
      return put(input)
    }

    const result = await sixb.models.audio.transcribe({
      audio: { data: new Uint8Array([7, 8, 9]), mediaType: "audio/wav; codecs=1" },
    })

    expect(result.output).toEqual({ text: "Hello" })
    expect(received).toEqual({ audio: new Uint8Array([7, 8, 9]), mediaType: "audio/wav" })
    expect(writes).toBe(0)
    expect(await storage.aiUsage.getLatestForExecution(identity)).toMatchObject({
      callId: result.callId,
      usage: { audioDurationMs: 900 },
    })
  })

  test("rejects empty, oversized and non-audio bytes before inference", async () => {
    let calls = 0
    const { sixb } = await setup(
      createTranscriber(async () => {
        calls++
        return { output: { text: "" } }
      })
    )

    for (const [audio, message] of [
      [{ data: new Uint8Array(), mediaType: "audio/wav" }, "nonempty"],
      [{ data: new Uint8Array(2048), mediaType: "audio/wav" }, "limit"],
      [{ data: new Uint8Array([1]), mediaType: "audio/mpeg" }, "not supported"],
      [{ data: new Uint8Array([1]), mediaType: "text/plain" }, "mediaType"],
    ] as const) {
      const error = await sixb.models.audio.transcribe({ audio }).catch((error) => error)
      expect(error).toBeInstanceOf(Error)
      expect((error as Error).message).toContain(message)
    }
    expect(calls).toBe(0)
  })

  // Removal proof: return input.data instead of a copy in prepareModelInputBytes; the edit lands.
  test("snapshots audio bytes before the first await", async () => {
    let received: Uint8Array | undefined
    const { sixb } = await setup(
      createTranscriber(async (request) => {
        received = request.audio
        return { output: { text: "Hello" } }
      })
    )
    const data = new Uint8Array([1, 2, 3])

    const pending = sixb.models.audio.transcribe({ audio: { data, mediaType: "audio/wav" } })
    data[0] = 9
    await pending
    expect(received).toEqual(new Uint8Array([1, 2, 3]))
  })

  test("runs a passed model as given, whether or not the catalog lists it", async () => {
    // Proven by removal: look the passed model up in models.audio.transcription again; the
    // same-id binding answers the catalog's "Hello" and the unlisted one is refused.
    const { sixb, audio } = await setup()
    const ownBinding = createTranscriber(async () => ({ output: { text: "Own binding" } }))
    const unlisted = {
      ...ownBinding,
      modelId: "unlisted",
      definition: { ...ownBinding.definition, modelId: "unlisted" },
    }

    for (const model of [ownBinding, unlisted]) {
      const result = await sixb.models.audio.transcribe({ audio, model })
      expect(result.output.text).toBe("Own binding")
    }
    expect(() => createModelCatalog({ audio: { transcription: [] } })).toThrow("at least one")
  })

  test("rejects oversized, mismatched and unsupported files before inference", async () => {
    let calls = 0
    const { sixb, audio } = await setup(
      createTranscriber(async () => {
        calls++
        return { output: { text: "" } }
      })
    )

    for (const [change, message] of [
      [{ sizeBytes: 2048 }, "limit"],
      [{ sizeBytes: 2 }, "does not match"],
      [{ mediaType: "audio/mpeg" }, "not supported"],
      [{ mediaType: "text/plain" }, "mediaType"],
    ] as const) {
      await expect(
        sixb.models.audio.transcribe({ audio: { ...audio, ...change } })
      ).rejects.toThrow(message)
    }
    expect(calls).toBe(0)
  })

  // Removal proof: remove the digest comparison in audio/file.ts; corrupted bytes reach inference.
  test("verifies streamed bytes, not only blob metadata", async () => {
    const { sixb, blobStorage, audio } = await setup()
    blobStorage.open = async () =>
      new ReadableStream({
        start(stream) {
          stream.enqueue(new Uint8Array([4, 5, 6]))
          stream.close()
        },
      })
    await expect(sixb.models.audio.transcribe({ audio })).rejects.toThrow("content-addressed")
  })

  test("cancels a pending file read without starting inference", async () => {
    const { sixb, blobStorage, audio, controller, storage, identity } = await setup()
    const opened = Promise.withResolvers<void>()
    let cancelled = false
    blobStorage.open = async () =>
      new ReadableStream({
        start() {
          opened.resolve()
        },
        cancel() {
          cancelled = true
        },
      })

    const pending = sixb.models.audio.transcribe({ audio })
    await opened.promise
    controller.abort()
    await expect(pending).rejects.toThrow()
    expect(cancelled).toBe(true)
    expect(await storage.aiUsage.getLatestForExecution(identity)).toBeNull()
  })

  test("accounts for a late billable reply after cancellation", async () => {
    const { sixb, audio, controller, storage, identity } = await setup(
      createTranscriber(async () => {
        controller.abort()
        return { output: { text: "Hello" }, usage: { audioDurationMs: 1000 } }
      })
    )

    await expect(sixb.models.audio.transcribe({ audio })).rejects.toThrow()
    expect(await storage.aiUsage.getLatestForExecution(identity)).toMatchObject({
      usage: { audioDurationMs: 1000 },
    })
  })

  test("records invalid replies once and never retries inference", async () => {
    let calls = 0
    const { sixb, audio, storage, identity } = await setup(
      createTranscriber(async () => {
        calls++
        throw new TranscriptionModelResponseError("invalid", "test", "transcriber", {
          usage: { audioDurationMs: 1500 },
          reportedCost: { money: { currency: "USD", amountNanos: "5000" } },
        })
      })
    )

    await expect(sixb.models.audio.transcribe({ audio })).rejects.toThrow("invalid")
    expect(calls).toBe(1)
    expect(await storage.aiUsage.summarizeExecution(identity)).toMatchObject({
      modelCallCount: 1,
      usage: { audioDurationMs: 1500 },
    })
  })

  test("snapshots file metadata before the first await", async () => {
    const { sixb, audio } = await setup()
    const mutable = { ...audio }

    const pending = sixb.models.audio.transcribe({ audio: mutable })
    mutable.sizeBytes = 99
    mutable.mediaType = "audio/other"
    expect((await pending).output.text).toBe("Hello")
  })

  test("an unknown cost estimate fails closed before inference", async () => {
    let calls = 0
    const { sixb, audio, storage } = await setup(
      createTranscriber(async () => {
        calls++
        return { output: { text: "" } }
      })
    )
    await storage.aiLimits.createPolicy({
      id: "limit",
      projectId: "audio",
      subject: { type: "project" },
      limit: {
        meter: "cost.catalogEstimated",
        amount: { currency: "USD", amountNanos: "1000000000" },
      },
    })
    await expect(sixb.models.audio.transcribe({ audio })).rejects.toMatchObject({
      code: "ai.usage_limit_unavailable",
    })
    expect(calls).toBe(0)
  })

  // Removal proof: drop the aiLimitMeterApplies filter in model-call-limits.ts; admission fails
  // with missingEstimate because transcription has no token estimate.
  test("token limits neither admit nor count transcription", async () => {
    let calls = 0
    const { sixb, audio, storage } = await setup(
      createTranscriber(async () => {
        calls++
        return { output: { text: "Hello" }, usage: { audioDurationMs: 1250 } }
      })
    )
    await storage.aiLimits.createPolicy({
      id: "tokens",
      projectId: "audio",
      subject: { type: "project" },
      limit: { meter: "tokens.total", amount: 10000 },
    })
    await sixb.models.audio.transcribe({ audio })
    await sixb.models.audio.transcribe({ audio })
    expect(calls).toBe(2)
    expect(await storage.aiLimits.listPolicyStatuses({ projectId: "audio" })).toMatchObject([
      { accountingStatus: "complete", consumption: { actual: { amount: 0 } } },
    ])
  })

  // Removal proof: reinstate the token-only early return in reservationEstimates; admission fails.
  test("a monetary reservation does not require a token estimate", async () => {
    const cost: ModelCostEstimate = {
      status: "rated",
      money: { currency: "USD", amountNanos: "125000" },
      components: [
        {
          meter: "audio.input.milliseconds",
          quantity: "1250",
          rateAmountNanosPerMillion: "100000000",
          chargeAmountNanos: "125000",
        },
      ],
    }
    const model: TranscriptionModel = {
      ...createTranscriber(async () => ({
        output: { text: "Hello" },
        usage: { audioDurationMs: 1250 },
      })),
      costEstimator: {
        estimateReservation: () => ({ currency: "USD", amountNanos: "200000" }),
        estimate: () => cost,
      },
    }
    const { sixb, audio, storage } = await setup(model)
    await storage.aiLimits.createPolicy({
      id: "cost",
      projectId: "audio",
      subject: { type: "project" },
      limit: {
        meter: "cost.catalogEstimated",
        amount: { currency: "USD", amountNanos: "1000000000" },
      },
    })

    const result = await sixb.models.audio.transcribe({ audio })
    const [policy] = await storage.aiLimits.listPolicyStatuses({ projectId: "audio" })

    expect(result.cost).toEqual(cost)
    expect(policy).toMatchObject({
      accountingStatus: "complete",
      consumption: {
        actual: { amount: { amountNanos: "125000" } },
        reserved: { amount: { amountNanos: "0" } },
      },
    })
  })
})
