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
  // Removal proof: remove assertProviderAccess from the audio runtime; the protected call succeeds.
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
      "not covered by scoped authorization"
    )
    expect(reads).toBe(0)
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

  test("uses the configured binding and validates catalog shape", async () => {
    const { sixb, audio } = await setup()
    const impostor = createTranscriber(async () => {
      throw new Error("impostor")
    })

    const result = await sixb.models.audio.transcribe({ audio, model: impostor })
    expect(result.output.text).toBe("Hello")

    await expect(
      sixb.models.audio.transcribe({ audio, model: { ...impostor, modelId: "other" } })
    ).rejects.toThrow("Configure")
    expect(() => createModelCatalog({ audio: { transcription: [] } })).toThrow("at least one")
    expect(() => createModelCatalog({ audio: { transcription: [impostor, impostor] } })).toThrow(
      "Duplicate"
    )
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

  test("unknown token or cost estimates fail closed before inference", async () => {
    for (const meter of ["tokens.total", "cost.catalogEstimated"] as const) {
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
        limit:
          meter === "tokens.total"
            ? { meter, amount: 10000 }
            : { meter, amount: { currency: "USD", amountNanos: "1000000000" } },
      })
      await expect(sixb.models.audio.transcribe({ audio })).rejects.toMatchObject({
        code: "ai.usage_limit_unavailable",
      })
      expect(calls).toBe(0)
    }
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
