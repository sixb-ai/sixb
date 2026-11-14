import { describe, expect, test } from "bun:test"
import {
  InMemoryBlobStorage,
  InMemoryBroker,
  InMemoryLakeStorage,
  InMemoryQueues,
  InMemoryStorage,
  question,
  SixbHost,
} from "@sixb/core"
import {
  DecisionModelResponseError,
  ModelProviderError,
  UnsupportedModelFeatureError,
} from "@sixb/core/models"
import { createTestSixb } from "@sixb/core/testing"
import { type AzureAIFoundryOptions, createAzureAIFoundry } from "../src"

const endpoint = "https://resource.services.ai.azure.com/api/projects/test"
const decisionUrl = "https://resource.services.ai.azure.com/providers/microsoft/v1/systemone"

// The record Azure's project discovery returned for a Microsoft-Decision-1 deployment.
const decisionDeployment = {
  type: "ModelDeployment",
  name: "decision-1",
  modelName: "Microsoft-Decision-1",
  modelVersion: "1",
  modelPublisher: "Microsoft",
  capabilities: { chat_completion: "false" },
  sku: { name: "GlobalStandard", capacity: 100 },
}
const chatDeployment = {
  type: "ModelDeployment",
  name: "chat",
  modelName: "future-chat",
  modelVersion: "1",
  modelPublisher: "Fixture",
  capabilities: { chat_completion: "true" },
  sku: { name: "GlobalStandard" },
}

const questions = {
  team: question.choice({
    instructions: "Which team handles this ticket?",
    options: { billing: "Invoices and refunds", support: "Product bugs" },
  }),
  urgency: question.score({ instructions: "How urgent?", levels: ["low", "medium", "high"] }),
  defect: question.probability("Is this a software defect?"),
}
const answers = {
  model: "microsoft-decision-1",
  answers: {
    team: {
      type: "choice",
      choice: "billing",
      confidence: 0.9,
      probabilities: { billing: 0.95, support: 0.05 },
    },
    urgency: {
      type: "score",
      score: 1.5,
      confidence: 0.3,
      legend: { "0": "low", "1": "medium", "2": "high" },
      probabilities: { "0": 0, "1": 0.5, "2": 0.5 },
    },
    defect: { type: "noul", noul: 0.2 },
  },
  usage: { input_tokens: 1_000_000, output_tokens: 3 },
}

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
        return Response.json({ value: options.deployments ?? [decisionDeployment, chatDeployment] })
      return inference(url, init)
    },
  })
  return { provider, calls }
}

describe("foundry.decision()", () => {
  test("posts System One to the resource with the deployment name and prices Microsoft-Decision-1", async () => {
    let request: { url: string; headers: Headers; body: unknown } | undefined
    const { provider, calls } = foundry(async (url, init) => {
      request = {
        url: String(url),
        headers: new Headers(init?.headers),
        body: JSON.parse(String(init?.body)),
      }
      return Response.json(answers, { headers: { "apim-request-id": "request-1" } })
    })
    const binding = provider.decision("decision-1")
    expect(calls).toEqual([])
    expect(binding.definition).toEqual({
      kind: "decision",
      providerId: "azure-ai-foundry",
      modelId: "decision-1",
      via: "Azure AI Foundry",
      capabilities: {
        questions: ["choice", "score", "probability"],
        maxChoices: 255,
        maxScoreLevels: 10,
      },
    })

    const model = await binding.resolve()
    const result = await model.evaluate({ input: { ticket: "Refund please" }, questions })

    expect(request?.url).toBe(decisionUrl)
    expect(request?.headers.get("api-key")).toBe("secret-key")
    expect(request?.headers.get("accept")).toBe("application/json")
    expect(request?.body).toEqual({
      model: "decision-1",
      state: { ticket: "Refund please" },
      questions: {
        team: {
          type: "choice",
          instructions: "Which team handles this ticket?",
          criteria: questions.team.options,
        },
        urgency: {
          type: "score",
          instructions: "How urgent?",
          criteria: ["low", "medium", "high"],
        },
        defect: { type: "noul", instructions: "Is this a software defect?" },
      },
    })
    expect(result).toEqual({
      output: {
        team: {
          choice: "billing",
          confidence: 0.9,
          probabilities: { billing: 0.95, support: 0.05 },
        },
        urgency: { score: 1.5, confidence: 0.3, probabilities: [0, 0.5, 0.5] },
        defect: { probability: 0.2 },
      },
      usage: { inputTokens: 1_000_000, outputTokens: 3 },
      responseModelId: "microsoft-decision-1",
      providerIds: { requestId: "request-1" },
    })
    expect(model.definition.publisher).toEqual({ id: "microsoft", name: "Microsoft" })
    expect(model.metadata).toMatchObject({
      modelName: "Microsoft-Decision-1",
      modelVersion: "1",
      sku: "GlobalStandard",
    })
    expect(
      model.costEstimator?.estimate({
        usage: result.usage!,
        responseModelId: result.responseModelId,
      })
    ).toMatchObject({ status: "rated", money: { currency: "USD", amountNanos: "42000000" } })
    expect(
      model.costEstimator?.estimateReservation?.({ inputTokens: 1_000_000, outputTokens: 10 })
    ).toEqual({
      currency: "USD",
      amountNanos: "42000000",
    })
  })

  test("an unresolved binding resolves once on its first direct call", async () => {
    let posts = 0
    const { provider, calls } = foundry(async () => {
      posts++
      return Response.json(answers)
    })
    const binding = provider.decision("decision-1")
    await binding.evaluate({ input: "x", questions })
    await binding.evaluate({ input: "x", questions })
    expect(posts).toBe(2)
    expect(calls.filter((path) => path.endsWith("/deployments"))).toHaveLength(1)
  })

  test("prices only Microsoft-Decision-1 version 1, as its own model answered", async () => {
    const usage = { inputTokens: 100, outputTokens: 1 }
    const price = async (deployment: object, responseModelId?: string, rateCard?: object) => {
      const { provider } = foundry(async () => Response.json(answers), {
        deployments: [{ ...decisionDeployment, ...deployment }],
      })
      const model = await provider
        .decision("decision-1", rateCard ? { rateCard: rateCard as never } : {})
        .resolve()
      return model.costEstimator?.estimate({ usage, responseModelId }).status
    }

    expect(await price({}, "microsoft-decision-1")).toBe("rated")
    expect(await price({}, "Microsoft-Decision-1")).toBe("rated")
    expect(await price({ modelVersion: "2" }, "microsoft-decision-1")).toBe("unpriceable")
    expect(await price({ modelName: "Microsoft-Decision-2" })).toBe("unpriceable")
    expect(await price({}, "another-model")).toBe("unpriceable")
    const card = { currency: "USD", input: "1", output: "1" }
    expect(await price({ modelVersion: "2" }, "microsoft-decision-1", card)).toBe("rated")
    expect(() =>
      foundry(async () => Response.json(answers)).provider.decision("decision-1", {
        rateCard: card as never,
        costEstimator: { estimate: () => ({ status: "unpriceable", reason: "missing-rate-card" }) },
      })
    ).toThrow("either rateCard or costEstimator")
  })

  test("keeps decision and language deployments apart", async () => {
    const { provider } = foundry(async () => {
      throw new Error("unexpected inference")
    })
    const notDecision = await provider
      .decision("chat")
      .resolve()
      .catch((error: unknown) => error)
    expect(notDecision).toBeInstanceOf(UnsupportedModelFeatureError)
    expect(String(notDecision)).toContain("runs future-chat, not a decision model")
    const asChat = await provider
      .chat("decision-1")
      .resolve()
      .catch((error: unknown) => error)
    expect(asChat).toBeInstanceOf(UnsupportedModelFeatureError)
    expect(String(asChat)).toContain("Use foundry.decision()")
    expect((await provider.catalog.list()).map((d) => d.modelId)).not.toContain("decision-1")

    const connected = foundry(async () => Response.json(answers), {
      deployments: [{ ...decisionDeployment, connectionName: "other-resource" }],
    }).provider
    await expect(connected.decision("decision-1").resolve()).rejects.toThrow("project connection")
    expect(() => provider.decision(" decision-1")).toThrow("deploymentName")
    expect(() => provider.decision("decision-1", { timeoutMs: 0 })).toThrow("timeoutMs")
    expect(() => provider.decision("decision-1", { timeoutMs: 2 ** 31 })).toThrow("timeoutMs")
    expect(() =>
      provider.decision("decision-1", { rateCard: { currency: "USD", input: "abc", output: "0" } })
    ).toThrow()
  })
})

describe("decision errors", () => {
  test("a rejected request keeps Azure's message and code and is not retried", async () => {
    let posts = 0
    const { provider } = foundry(async () => {
      posts++
      return Response.json(
        {
          error: {
            code: "unsupported_request_argument",
            message:
              "Model does not support request argument supplied: choice question q requires 2-255 options",
          },
        },
        { status: 400 }
      )
    })
    const model = await provider.decision("decision-1").resolve()
    const error = await model.evaluate({ input: "x", questions }).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(ModelProviderError)
    expect(error).toMatchObject({
      status: 400,
      code: "unsupported_request_argument",
      retryable: false,
    })
    expect(String(error)).toContain("requires 2-255 options")
    expect(posts).toBe(1)
  })

  test("a context-limit rejection says so", async () => {
    // Removal proof: drop the `detail` branch in transport.ts; the message is only the status.
    const { provider } = foundry(async () =>
      Response.json(
        {
          detail:
            "invalid model request: Question prompt exceeds the 32768-token context limit including the decision token",
        },
        { status: 422 }
      )
    )
    const model = await provider.decision("decision-1").resolve()
    await expect(model.evaluate({ input: "x", questions })).rejects.toThrow(
      "exceeds the 32768-token context limit"
    )
  })

  test("throttling and server errors are not replayed; the error says when to retry", async () => {
    // Removal proof: drop `protocol === "decision"` from the retry exemption in transport.ts.
    for (const status of [429, 504]) {
      let posts = 0
      const { provider } = foundry(
        async () => {
          posts++
          return new Response(null, { status, headers: { "retry-after-ms": "250" } })
        },
        { maxRetries: 2 }
      )
      const model = await provider.decision("decision-1").resolve()
      const error = await model.evaluate({ input: "x", questions }).catch((e: unknown) => e)
      expect(error).toMatchObject({ status, retryable: true, retryAfterMs: 250 })
      expect(posts).toBe(1)
    }
  })

  test("answers from another model are rejected, keeping the usage unpriced", async () => {
    // Removal proof: drop assertModel in decision.ts; the answers come back.
    const { provider } = foundry(async () => Response.json({ ...answers, model: "other-model" }))
    const model = await provider.decision("decision-1").resolve()
    const error = await model.evaluate({ input: "x", questions }).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(DecisionModelResponseError)
    const metadata = (error as DecisionModelResponseError).metadata
    expect(metadata).toMatchObject({
      responseModelId: "other-model",
      usage: { inputTokens: 1_000_000 },
    })
    expect(
      model.costEstimator?.estimate({
        usage: metadata.usage!,
        responseModelId: metadata.responseModelId,
      }).status
    ).toBe("unpriceable")

    const missing = await foundry(async () => Response.json({ answers: answers.answers }))
      .provider.decision("decision-1")
      .resolve()
    await expect(missing.evaluate({ input: "x", questions })).rejects.toBeInstanceOf(
      DecisionModelResponseError
    )
  })

  test("the timeout and the caller's signal both reach the transport", async () => {
    const hang: Fetch = (_, init) =>
      new Promise((_, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal!.reason), { once: true })
      })
    const { provider } = foundry(hang)
    const timed = await provider.decision("decision-1", { timeoutMs: 5 }).resolve()
    const timeout = await timed.evaluate({ input: "x", questions }).catch((e: unknown) => e)
    expect(timeout).toMatchObject({ name: "TimeoutError" })

    const controller = new AbortController()
    const model = await provider.decision("decision-1").resolve()
    const pending = model
      .evaluate({ input: "x", questions, signal: controller.signal })
      .catch((e: unknown) => e)
    controller.abort(new Error("cancelled"))
    expect(await pending).toMatchObject({ message: "cancelled" })
  })

  test("invalid JSON is a provider error; invalid answers keep the billable usage", async () => {
    const invalid = await foundry(async () => new Response("{"))
      .provider.decision("decision-1")
      .resolve()
    await expect(invalid.evaluate({ input: "x", questions })).rejects.toMatchObject({
      code: "invalid_json",
    })

    const malformed = await foundry(async () =>
      Response.json({ ...answers, answers: { ...answers.answers, defect: undefined } })
    )
      .provider.decision("decision-1")
      .resolve()
    const error = await malformed.evaluate({ input: "x", questions }).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(DecisionModelResponseError)
    expect(error).toMatchObject({
      metadata: { usage: { inputTokens: 1_000_000, outputTokens: 3 } },
    })
  })
})

function host(models: ConstructorParameters<typeof SixbHost>[0]["models"]) {
  return new SixbHost({
    id: "foundry-decision",
    ontology: [],
    models,
    storage: new InMemoryStorage(),
    broker: new InMemoryBroker(),
    queues: new InMemoryQueues(),
    blobStorage: new InMemoryBlobStorage(),
    lakeStorage: new InMemoryLakeStorage(),
  })
}

describe("in a project", () => {
  test("sixb.models.decision.evaluate() runs it and records usage and cost", async () => {
    const { provider } = foundry(async () => Response.json(answers))
    const project = host({ decision: [provider.decision("decision-1")] })
    const sixb = createTestSixb(project)
    const result = await sixb.models.decision.evaluate({ input: "Refund please", questions })

    expect(result.output.team.choice).toBe("billing")
    expect(result.cost).toMatchObject({ status: "rated", money: { amountNanos: "42000000" } })
    expect(
      await project.storage.aiUsage!.getLatestForExecution({
        projectId: project.id,
        executionId: sixb.execution.id,
      })
    ).toMatchObject({
      callId: result.callId,
      modelKind: "decision",
      requestedModelId: "decision-1",
      responseModelId: "microsoft-decision-1",
    })
  })

  test("it picks the tier of each chat message", async () => {
    // Removal proof: declare maxChoices below 3 in decision.ts; startup rejects the router.
    const tierAnswer = {
      model: "microsoft-decision-1",
      answers: {
        tier: {
          type: "choice",
          choice: "heavy",
          confidence: 0.6,
          probabilities: { light: 0.05, standard: 0.15, heavy: 0.8 },
        },
      },
      usage: { input_tokens: 200, output_tokens: 1 },
    }
    const asked: unknown[] = []
    const { provider } = foundry(
      async (_, init) => {
        asked.push(JSON.parse(String(init?.body)))
        return Response.json(tierAnswer)
      },
      {
        deployments: [
          decisionDeployment,
          ...["flash", "kimi", "opus"].map((name) => ({ ...chatDeployment, name })),
        ],
      }
    )
    const project = host({
      language: {
        light: provider.chat("flash"),
        standard: provider.chat("kimi"),
        heavy: provider.chat("opus"),
      },
      decision: [provider.decision("decision-1")],
    })
    const { run } = await createTestSixb(project).agent.runs.request({
      text: "Why did energy use rise last quarter? Compare sites and draft a plan.",
    })

    expect(run.spec).toMatchObject({
      model: { provider: "azure-ai-foundry", modelId: "opus" },
      tier: "heavy",
      tierProbabilities: { light: 0.05, standard: 0.15, heavy: 0.8 },
    })
    expect(asked).toMatchObject([{ model: "decision-1", questions: { tier: { type: "choice" } } }])
  })
})
