import { afterEach, describe, expect, spyOn, test } from "bun:test"
import {
  agentContextSizeTokens,
  calibrateAgentContextBytesPerToken,
  estimateAgentContextRequestTokens,
  measureAgentContextTokenRate,
  measureModelRequest,
  readAgentContextTokenRates,
} from "../src/agents"
import { measureAgentContextRequest } from "../src/agents/context-compaction"
import {
  AGENT_CONTEXT_DEFAULT_BYTES_PER_TOKEN,
  type AgentContextTokenRateSample,
  learnedAgentContextBytesPerToken,
  recordAgentContextTokenRate,
} from "../src/agents/context-token-rate"
import type { AgentMessage } from "../src/agents/message"
import type { ModelMessage, ModelToolSpecification } from "../src/models"
import { type AgentTokenRateStore, InMemoryAgentStorage } from "../src/storage/agents"
import { InMemoryAuthStorage } from "../src/storage/auth"
import { InMemoryExecutionStorage } from "../src/storage/executions/in-memory"

const text = (bytes: number) => "a".repeat(bytes)

/** An outgoing request, weighed and priced as the output ceiling prices it. */
const estimateModelRequestTokens = (
  request: { readonly messages: ModelMessage[]; readonly tools: ModelToolSpecification[] },
  bytesPerToken: number
) => agentContextSizeTokens(measureModelRequest(request), bytesPerToken)

describe("agent context token rate", () => {
  test("prices the same text alike in a stored conversation and an outgoing request", () => {
    // Removal proof: estimate outgoing requests by their serialized JSON again; the two counts of
    // the same 300,000 bytes drift apart by the JSON around them.
    const bytesPerToken = 2.1
    const body = text(300_000)
    const stored = estimateAgentContextRequestTokens({
      systemPrompt: "System",
      tools: [],
      messages: [{ role: "user", parts: [{ type: "text", text: body }] }],
      bytesPerToken,
    }).tokens
    const outgoing = estimateModelRequestTokens(
      {
        messages: [
          { role: "system", content: "System" },
          { role: "user", content: [{ type: "text", text: body }] },
        ],
        tools: [],
      },
      bytesPerToken
    )

    expect(stored).toBe(Math.ceil(300_006 / 2.1) + 16)
    expect(Math.abs(outgoing - stored)).toBeLessThanOrEqual(8)
  })

  test("counts tool calls, tool results and the tool catalog of an outgoing request", () => {
    const bytesPerToken = 4
    const bare = estimateModelRequestTokens({ messages: [], tools: [] }, bytesPerToken)
    const withTools = estimateModelRequestTokens(
      {
        messages: [
          {
            role: "assistant",
            content: [{ type: "tool-call", toolCallId: "c", toolName: "read", input: { a: 1 } }],
          },
          {
            role: "tool",
            content: [
              {
                type: "tool-result",
                toolCallId: "c",
                toolName: "read",
                output: { type: "text", value: text(4_000) },
              },
            ],
          },
        ],
        tools: [{ name: "read", description: "Read a file", inputSchema: { type: "object" } }],
      },
      bytesPerToken
    )

    expect(withTools - bare).toBeGreaterThan(1_000)
  })
})

describe("agent context rate calibration", () => {
  const request = (bytes: number) => ({
    systemPrompt: text(bytes),
    tools: [],
    messages: [] as AgentMessage[],
  })

  const calibrate = (inputTokens: number) =>
    calibrateAgentContextBytesPerToken({
      bytesPerToken: 2,
      size: measureAgentContextRequest(request(30_000)),
      inputTokens,
    })

  // Removal proof: return input.bytesPerToken from calibrateAgentContextBytesPerToken; a thread
  // whose calls show 2.4 bytes per token keeps being counted at 2.
  test("takes the rate a thread's own call measured", () => {
    // 30,000 bytes over 12,500 text tokens, plus the request's 8.
    expect(calibrate(12_508)).toBe(2.4)
  })

  // Removal proof: drop the clamp; one call carrying an unreplayed image measures 0.5 bytes per
  // token and the next estimate quadruples, or one whose stored bytes bill for less measures 15.
  test("lets a measured rate fall to half the run's, and rise only a quarter", () => {
    expect(calibrate(60_008)).toBe(1)
    expect(calibrate(2_008)).toBe(2.5)
    // Reproduce: clamp upward at twice the run's rate again; 3 bytes per token pass through.
    expect(calibrate(10_008)).toBe(2.5)
  })

  // Removal proof: drop the image check from measureAgentContextTokenRate, or the image count from
  // measureAgentContextRequest; the screenshot's 5,400-token allowance comes off the provider's
  // count and the thread calibrates to its text read sparser than it is.
  test("keeps the run's rate when the call read an image", () => {
    const withImage: AgentMessage = {
      role: "user",
      parts: [
        { type: "text", text: text(30_000) },
        {
          type: "file",
          fileRef: {
            blobId: `blob_${"0".repeat(64)}`,
            digest: `sha256:${"0".repeat(64)}`,
            sizeBytes: 400_000,
            fileName: "screen.png",
            mediaType: "image/png",
          },
        },
      ],
    }
    const size = measureAgentContextRequest({ systemPrompt: "", tools: [], messages: [withImage] })

    expect(size.images).toBe(1)
    expect(measureAgentContextTokenRate({ size, inputTokens: 14_000 })).toBeUndefined()
    expect(
      calibrateAgentContextBytesPerToken({ bytesPerToken: 2, size, inputTokens: 14_000 })
    ).toBe(2)
  })

  // Removal proof: drop CALIBRATION_MIN_TEXT_TOKENS; a 600-byte call's overheads set the rate.
  test("keeps the run's rate when the call is too small to measure", () => {
    expect(
      calibrateAgentContextBytesPerToken({
        bytesPerToken: 2,
        size: measureAgentContextRequest(request(600)),
        inputTokens: 300,
      })
    ).toBe(2)
  })
})

describe("a model's learned rate", () => {
  const model = { providerId: "anthropic", modelId: "claude-haiku-5.5" }
  const t0 = Date.parse("2026-11-01T10:00:00.000Z")
  let runs = 0

  afterEach(() => {
    runs = 0
  })

  const project = () => {
    const agents = new InMemoryAgentStorage(new InMemoryExecutionStorage(new InMemoryAuthStorage()))
    return agents.tokenRates
  }

  /** One run's measurement at `rate` bytes per token, each run a minute after the one before. */
  const recordRun = async (tokenRates: AgentTokenRateStore, rate: number) => {
    runs += 1
    await recordAgentContextTokenRate({
      tokenRates,
      projectId: "project",
      runId: `run_${String(runs).padStart(3, "0")}`,
      sample: { ...model, bytes: Math.round(rate * 10_000), tokens: 10_000 },
      measuredAt: new Date(t0 + runs * 60_000),
    })
  }

  /** The rate a run on the model starts from, as its plan reads the project's measurements. */
  const learned = async (tokenRates: AgentTokenRateStore) =>
    learnedAgentContextBytesPerToken(
      await readAgentContextTokenRates({ tokenRates, projectId: "project", model })
    )

  const samples = (...rates: number[]): AgentContextTokenRateSample[] =>
    rates.map((rate) => ({ bytes: Math.round(rate * 10_000), tokens: 10_000 }))

  test("starts a model no run measured at a rate denser than any tokenizer's", async () => {
    // Removal proof: return the median from learnedAgentContextBytesPerToken for an empty window;
    // NaN reaches every estimate.
    expect(AGENT_CONTEXT_DEFAULT_BYTES_PER_TOKEN).toBe(2)
    expect(await learned(project())).toBe(2)
  })

  test("is what the model's previous runs measured, for its next one", async () => {
    // Removal proof: return no measurement from readAgentContextTokenRates; the next run starts at
    // 2 again.
    const tokenRates = project()
    await recordRun(tokenRates, 4.5)

    expect(await learned(tokenRates)).toBe(4.5)
    expect(
      await readAgentContextTokenRates({
        tokenRates,
        projectId: "project",
        model: { ...model, modelId: "claude-sonnet-5" },
      })
    ).toEqual([])
  })

  test("follows a tokenizer that changes from its 10th run when denser, its 11th when sparser", async () => {
    // Reproduce: take the 10th percentile again (the second densest of 20); the denser tokenizer
    // then takes over from its second run.
    const denser = project()
    for (let index = 0; index < 20; index++) await recordRun(denser, 4.4)
    for (let index = 0; index < 9; index++) await recordRun(denser, 2.2)
    expect(await learned(denser)).toBe(4.4)
    await recordRun(denser, 2.2)
    expect(await learned(denser)).toBe(2.2)

    const sparser = project()
    for (let index = 0; index < 20; index++) await recordRun(sparser, 2.2)
    for (let index = 0; index < 10; index++) await recordRun(sparser, 4.4)
    expect(await learned(sparser)).toBe(2.2)
    await recordRun(sparser, 4.4)
    expect(await learned(sparser)).toBe(4.4)
  })

  test("is not moved by a few runs whose content reads dense, nor by an odd sparse one", () => {
    // Reproduce: take the 10th percentile again; five base64-heavy runs among fifteen of prose
    // then set the rate at 1.2, and every later thread on the model starts twice too high.
    const usual = Array.from({ length: 15 }, () => 2.4)

    expect(learnedAgentContextBytesPerToken(samples(1.2, 1.2, 1.2, 1.2, 1.2, ...usual))).toBe(2.4)
    expect(learnedAgentContextBytesPerToken(samples(9, ...usual, 2.4, 2.4, 2.4, 2.4))).toBe(2.4)
    // Of an even count, the denser of the middle two: the safe side.
    expect(learnedAgentContextBytesPerToken(samples(2.6, 2.4, 3, 3.2))).toBe(2.6)
  })

  test("stays within the band any tokenizer measures, whatever a stored measurement says", () => {
    // Removal proof: drop the clamp from learnedAgentContextBytesPerToken; one byte per billion
    // tokens becomes the model's rate, every estimate passes the budget, and no call replaces it.
    const forged = [{ bytes: 1, tokens: 1_000_000_000 }]

    expect(learnedAgentContextBytesPerToken(forged)).toBe(1)
    expect(learnedAgentContextBytesPerToken(samples(40))).toBe(8)
  })

  test("falls back to the default when storage cannot read, and never fails a run on a write", async () => {
    // Removal proof: drop the try in readAgentContextTokenRates or recordAgentContextTokenRate;
    // the storage failure reaches the run.
    const warn = spyOn(console, "warn").mockImplementation(() => {})
    const broken: AgentTokenRateStore = {
      record: () => Promise.reject(new Error("storage down")),
      listLatest: () => Promise.reject(new Error("storage down")),
    }

    try {
      expect(await learned(broken)).toBe(2)
      await recordRun(broken, 2.4)
      expect(warn).toHaveBeenCalledTimes(2)
    } finally {
      warn.mockRestore()
    }
  })
})
