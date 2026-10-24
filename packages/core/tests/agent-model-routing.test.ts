import { afterEach, describe, expect, jest, mock, setSystemTime, spyOn, test } from "bun:test"
import { agent, can, defineGroup, defineRole, SixbHost } from "../src"
import { emptyGrantIndex } from "../src/authorization"
import { bindRequestExecution } from "../src/execution/request"
import type {
  DecisionModel,
  DecisionModelRequest,
  DecisionModelResult,
  LanguageModelTier,
  ModelCatalogInput,
} from "../src/models"
import type { ConversationAgentRunRecord } from "../src/storage/agents"
import { testLanguageModel } from "./helpers/language-model"
import { createTestRuntimeDeps } from "./test-runtime-deps"

const users = defineGroup("chat-users")
// Only the Agent: the tier is the Agent's question, not one the user asks the models.
const chatter = defineRole("chat.user", { grantedTo: [users], grants: [can.run(agent)] })

const flash = testLanguageModel("flash")
const sonnet = testLanguageModel("sonnet")
const opus = testLanguageModel("opus")
const gpt = testLanguageModel("gpt")
const tiers = { light: flash, standard: sonnet, heavy: [opus, gpt] }

type Probabilities = Record<LanguageModelTier, number>

const LIGHT = { light: 0.9, standard: 0.1, heavy: 0 }
const STANDARD = { light: 0.1, standard: 0.8, heavy: 0.1 }
const HEAVY = { light: 0, standard: 0.1, heavy: 0.9 }

function ref(modelId: string) {
  return { provider: "test", modelId }
}

function tierAnswer(probabilities: Probabilities): DecisionModelResult {
  const [choice] = Object.entries(probabilities).sort(([, left], [, right]) => right - left)[0]!
  return { output: { tier: { choice, probabilities } } }
}

function decisionModel(
  evaluate: (request: DecisionModelRequest) => Promise<DecisionModelResult>,
  capabilities: DecisionModel["definition"]["capabilities"] = { questions: ["choice"] }
): DecisionModel {
  return {
    providerId: "test",
    modelId: "router",
    definition: {
      kind: "decision",
      providerId: "test",
      modelId: "router",
      capabilities,
    },
    evaluate,
  }
}

/** A decision model answering what the test last set. */
function router() {
  let probabilities: Probabilities = STANDARD
  const evaluate = mock(async (_request: DecisionModelRequest) => tierAnswer(probabilities))
  return {
    model: decisionModel(evaluate),
    evaluate,
    answer(next: Probabilities) {
      probabilities = next
    },
  }
}

function setup(
  models: Pick<ModelCatalogInput, "language" | "decision">,
  deps = createTestRuntimeDeps()
) {
  const host = new SixbHost({
    id: "agent-model-routing",
    ontology: [],
    models,
    groups: [users],
    roles: [chatter],
    ...deps,
  })
  return { host, ...deps }
}

async function createUser(host: SixbHost) {
  await host.storage.auth!.users.create({ projectId: host.id, id: "u1", email: "u1@example.com" })
  await host.storage.auth!.sessions.create({
    projectId: host.id,
    id: "session-u1",
    userId: "u1",
    strategyId: "test",
    tokenHash: "session-u1",
    createdAt: new Date(),
    expiresAt: new Date("2100-01-01T00:00:00.000Z"),
  })
}

function userScope(host: SixbHost, signal?: AbortSignal) {
  return bindRequestExecution(host, {
    request: new Request("http://localhost/test", signal ? { signal } : {}),
    authorization: {
      type: "principal",
      credential: { type: "session", id: "session-u1" },
      context: {
        principal: { type: "user", id: "u1" },
        sessionId: "session-u1",
        groupIds: [],
        roleIds: [],
        grants: { ...emptyGrantIndex(), "run:agent": true },
      },
    },
  })
}

/** Ends a turn at the current time, which starts its prompt cache's idle clock. */
async function finish(host: SixbHost, run: ConversationAgentRunRecord) {
  await host.storage.agents!.runs.finishQueued({
    projectId: host.id,
    id: run.id,
    status: "cancelled",
  })
}

async function routedSetup() {
  const decision = router()
  const { host, storage } = setup({ language: tiers, decision: [decision.model] })
  await createUser(host)
  return { host, storage, decision, sixb: userScope(host) }
}

afterEach(() => {
  jest.useRealTimers()
  setSystemTime()
  mock.restore()
})

function reasoningModel(modelId: string, efforts: readonly ("low" | "high")[]) {
  const model = testLanguageModel(modelId)
  return {
    ...model,
    definition: { ...model.definition, capabilities: { reasoning: { efforts } } },
  }
}

describe("Sixb picks the model of each turn", () => {
  test("needs a default decision model that takes the tier question", () => {
    // Proven by removal: drop assertTurnModelRouting from resolveDefinitions; startup passes and
    // every turn warns and runs on standard.
    const evaluate = async () => tierAnswer(STANDARD)
    const scoresOnly = decisionModel(evaluate, { questions: ["score"] })
    const twoChoices = decisionModel(evaluate, { questions: ["choice"], maxChoices: 2 })

    for (const model of [scoresOnly, twoChoices]) {
      expect(() => setup({ language: tiers, decision: [model] })).toThrow(
        "[Sixb] The default decision model 'test/router' cannot pick the tier of an Agent turn: it needs 'choice' questions with 3 options."
      )
    }

    // A list routes nothing, so any decision model will do; three choices are enough.
    const threeChoices = decisionModel(evaluate, { questions: ["choice"], maxChoices: 3 })
    expect(() => setup({ language: [sonnet], decision: [scoresOnly] })).not.toThrow()
    expect(() => setup({ language: tiers, decision: [threeChoices] })).not.toThrow()
  })

  test("keeps the default model without tiers or without a decision model", async () => {
    const warn = spyOn(console, "warn")

    // Proven by removal: drop the tier check in createTurnModelRouter; the list gets routed.
    const listed = router()
    const list = setup({ language: [sonnet, opus], decision: [listed.model] })
    await createUser(list.host)
    listed.answer(HEAVY)
    const fromList = await userScope(list.host).agent.runs.request({ text: "Why?" })
    expect(fromList.run.spec).toEqual({ model: ref("sonnet") })
    expect(listed.evaluate).toHaveBeenCalledTimes(0)

    // Proven by removal: drop the decision check; the turn warns of a decision it cannot ask.
    const tiered = setup({ language: tiers })
    await createUser(tiered.host)
    const fromTiers = await userScope(tiered.host).agent.runs.request({ text: "Why?" })
    expect(fromTiers.run.spec).toEqual({ model: ref("sonnet"), tier: "standard" })
    expect(warn).toHaveBeenCalledTimes(0)
  })

  test("moves up from 0.4 heavy and down only from 0.8 light", async () => {
    // Proven by removal: move either threshold, or compare with `>`; an edge row fails.
    const { host, storage, decision, sixb } = await routedSetup()
    const cases: [Probabilities, LanguageModelTier, string][] = [
      [{ light: 0.2, standard: 0.4, heavy: 0.4 }, "heavy", "opus"],
      [{ light: 0.3, standard: 0.31, heavy: 0.39 }, "standard", "sonnet"],
      [{ light: 0.8, standard: 0.2, heavy: 0 }, "light", "flash"],
      [{ light: 0.79, standard: 0.21, heavy: 0 }, "standard", "sonnet"],
    ]

    for (const [probabilities, tier, modelId] of cases) {
      decision.answer(probabilities)
      const { run } = await sixb.agent.runs.request({ text: "How many open orders?" })
      expect(run.spec).toEqual({ model: ref(modelId), tier, tierProbabilities: probabilities })
    }

    expect(decision.evaluate).toHaveBeenCalledTimes(cases.length)
    expect(decision.evaluate.mock.calls[0]![0].input).toBe("How many open orders?")
    // Accounted like any model call, on the request that admitted the turn.
    expect(
      await storage.aiUsage.getLatestForExecution({
        projectId: host.id,
        executionId: sixb.execution.id,
      })
    ).toMatchObject({ modelKind: "decision", requestedModelId: "router" })
  })

  test("moves a harder turn up, warm cache or not", async () => {
    // Proven by removal: make a warm cache keep the model for any change of tier.
    const { host, decision, sixb } = await routedSetup()
    decision.answer(LIGHT)
    const first = await sixb.agent.runs.request({ text: "How many orders?" })
    expect(first.run.spec?.model).toEqual(ref("flash"))
    await finish(host, first.run)

    decision.answer(HEAVY)
    const { run } = await sixb.agent.runs.request({ threadId: first.run.threadId, text: "Why?" })
    expect(run.spec).toMatchObject({ model: ref("opus"), tier: "heavy" })
  })

  test("stays on the exact previous model while the cache is warm, and moves down once cold", async () => {
    const { host, decision, sixb } = await routedSetup()
    setSystemTime(new Date("2026-10-24T10:00:00.000Z"))
    // An explicit model asks nothing, and its turn takes the tier the model is in.
    const first = await sixb.agent.runs.request({ text: "Compare", model: ref("gpt") })
    expect(first.run.spec).toEqual({ model: ref("gpt"), tier: "heavy" })
    expect(decision.evaluate).toHaveBeenCalledTimes(0)
    await finish(host, first.run)
    const threadId = first.run.threadId

    // Same tier, even cold: the thread's model, not the tier's first. Proven by removal: drop
    // `change === 0` from turnModel; the turn moves to opus.
    setSystemTime(new Date("2026-10-24T10:30:00.000Z"))
    decision.answer(HEAVY)
    const same = await sixb.agent.runs.request({ threadId, text: "And the West?" })
    expect(same.run.spec?.model).toEqual(ref("gpt"))
    await finish(host, same.run)

    // Proven by removal: drop the warm-cache branch; the turn moves down to flash.
    setSystemTime(new Date("2026-10-24T10:34:59.999Z"))
    decision.answer(LIGHT)
    const warm = await sixb.agent.runs.request({ threadId, text: "Thanks, how many?" })
    expect(warm.run.spec).toMatchObject({ model: ref("gpt"), tier: "heavy" })
    expect(warm.run.spec?.tierProbabilities).toEqual(LIGHT)
    await finish(host, warm.run)

    // Proven by removal: compare with `<=`; five idle minutes would still count as warm.
    setSystemTime(new Date("2026-10-24T10:39:59.999Z"))
    const cold = await sixb.agent.runs.request({ threadId, text: "And yesterday?" })
    expect(cold.run.spec).toMatchObject({ model: ref("flash"), tier: "light" })
  })

  test("takes an older turn's tier from its model", async () => {
    // Proven by removal: drop `?? model?.tier`; the older turn counts as none, so it moves down.
    const deps = createTestRuntimeDeps()
    const before = setup({ language: [opus, sonnet] }, deps)
    await createUser(before.host)
    const first = await userScope(before.host).agent.runs.request({ text: "Why?" })
    expect(first.run.spec).toEqual({ model: ref("opus") })
    await finish(before.host, first.run)

    const decision = router()
    const after = setup({ language: tiers, decision: [decision.model] }, deps)
    decision.answer(LIGHT)
    const { run } = await userScope(after.host).agent.runs.request({
      threadId: first.run.threadId,
      text: "Thanks",
    })
    expect(run.spec).toMatchObject({ model: ref("opus"), tier: "heavy" })
  })

  test("runs the default model when a message names a reasoning", async () => {
    // Proven by removal: route on `selection.model === undefined` alone; the turn goes to the
    // heavy model, which refuses `low` and accepts `high`.
    const decision = router()
    const standard = reasoningModel("sonnet", ["low"])
    const heavy = reasoningModel("opus", ["high"])
    const { host } = setup({
      language: { light: flash, standard, heavy },
      decision: [decision.model],
    })
    await createUser(host)
    const sixb = userScope(host)
    decision.answer(HEAVY)

    const { run } = await sixb.agent.runs.request({ text: "Why?", reasoning: "low" })
    expect(run.spec).toEqual({ model: ref("sonnet"), tier: "standard", reasoning: "low" })

    const refused = await sixb.agent.runs
      .request({ text: "Why?", reasoning: "high" })
      .catch((error) => error)
    expect(refused).toMatchObject({ code: "invalid_model_selection" })
    expect(refused.message).toContain("'test/sonnet' cannot use this reasoning")
    expect(decision.evaluate).toHaveBeenCalledTimes(0)
  })

  test("never asks again to continue or retry a turn", async () => {
    // Proven by removal: route on `input.model === undefined` alone; the continuation asks.
    const { host, decision, sixb } = await routedSetup()
    decision.answer(HEAVY)
    const first = await sixb.agent.runs.request({ text: "Write the report" })
    await finish(host, first.run)

    decision.answer(LIGHT)
    const continued = await sixb.agent.runs.request({
      threadId: first.run.threadId,
      continue: true,
    })
    expect(continued.run.spec).toEqual({ model: ref("opus"), tier: "heavy" })

    await host.storage.agents!.runs.finishQueued({
      projectId: host.id,
      id: continued.run.id,
      status: "failed",
    })
    const retried = await sixb.agent.runs.retry(continued.run.id)
    expect(retried.run.spec).toEqual(continued.run.spec)
    expect(decision.evaluate).toHaveBeenCalledTimes(1)
  })

  test("asks nothing for a message it refuses", async () => {
    // Proven by removal: route before the thread's active-run check.
    const { decision, sixb } = await routedSetup()
    const first = await sixb.agent.runs.request({ text: "Why?" })

    const error = await sixb.agent.runs
      .request({ threadId: first.run.threadId, text: "And?" })
      .catch((error) => error)
    expect(error).toMatchObject({ code: "active_run_exists" })
    expect(decision.evaluate).toHaveBeenCalledTimes(1)
  })

  test("runs on standard when the decision model fails", async () => {
    // Proven by removal: rethrow in askTier; the message is refused.
    const warn = spyOn(console, "warn").mockImplementation(() => {})
    const failures = [
      decisionModel(async () => {
        throw new Error("Gateway down")
      }),
      // An answer outside the question's options.
      decisionModel(async () => ({
        output: { tier: { choice: "medium", probabilities: { medium: 1 } } },
      })),
    ]

    for (const model of failures) {
      const { host, storage } = setup({ language: tiers, decision: [model] })
      await createUser(host)
      const { run } = await userScope(host).agent.runs.request({ text: "Why?" })
      expect(run).toMatchObject({
        status: "queued",
        spec: { model: ref("sonnet"), tier: "standard" },
      })
      expect(run.spec?.tierProbabilities).toBeUndefined()
      expect((await storage.agents.threads.list({ projectId: host.id })).total).toBe(1)
    }

    expect(warn).toHaveBeenCalledTimes(failures.length)
    expect(warn.mock.calls[0]![0]).toBe(
      "[Sixb] Could not pick the tier of an Agent turn; it aims for standard, and the cache rule still applies."
    )
  })

  test("keeps a warm heavy thread on heavy when the decision model fails", async () => {
    // Proven by removal: return the standard model from `choose` when askTier fails, without
    // turnModel; the turn drops to sonnet and loses the thread's prompt cache.
    spyOn(console, "warn").mockImplementation(() => {})
    let fails = false
    const model = decisionModel(async () => {
      if (fails) throw new Error("Gateway down")
      return tierAnswer(HEAVY)
    })
    const { host } = setup({ language: tiers, decision: [model] })
    await createUser(host)
    const sixb = userScope(host)

    setSystemTime(new Date("2026-10-24T10:00:00.000Z"))
    const first = await sixb.agent.runs.request({ text: "Why did sales drop?" })
    expect(first.run.spec).toMatchObject({ model: ref("opus"), tier: "heavy" })
    await finish(host, first.run)

    setSystemTime(new Date("2026-10-24T10:01:00.000Z"))
    fails = true
    const { run } = await sixb.agent.runs.request({ threadId: first.run.threadId, text: "And?" })
    expect(run.spec).toEqual({ model: ref("opus"), tier: "heavy" })
  })

  test("runs on standard when the decision model is too slow, even if it ignores the signal", async () => {
    // Proven by removal: drop rejectOnAbort from the race; the request never settles.
    jest.useFakeTimers()
    spyOn(console, "warn").mockImplementation(() => {})
    const { promise: asked, resolve } = Promise.withResolvers<void>()
    const model = decisionModel(() => {
      resolve()
      return new Promise<never>(() => {})
    })
    const { host } = setup({ language: tiers, decision: [model] })
    await createUser(host)

    const request = userScope(host).agent.runs.request({ text: "Why?" })
    await asked
    jest.advanceTimersByTime(2_000)
    const { run } = await request
    expect(run.spec).toEqual({ model: ref("sonnet"), tier: "standard" })
  })

  test("a cancelled request still cancels, before anything is written", async () => {
    // Proven by removal: drop the abort rethrow in askTier; the turn is admitted on standard.
    const controller = new AbortController()
    const model = decisionModel(
      (request) =>
        new Promise<never>((_, reject) => {
          request.signal?.addEventListener("abort", () => reject(request.signal?.reason))
          controller.abort()
        })
    )
    const { host, storage } = setup({ language: tiers, decision: [model] })
    await createUser(host)

    const error = await userScope(host, controller.signal)
      .agent.runs.request({ text: "Why?" })
      .catch((error) => error)
    expect(error).toMatchObject({ name: "AbortError" })
    expect((await storage.agents.threads.list({ projectId: host.id })).total).toBe(0)
  })
})
