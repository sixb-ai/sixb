import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createSixb, defineAgentTool, defineObjectType, prop } from "../src"
import { webDomainPolicy } from "../src/agents"
import { type AgentWebOptions, bindAgentWebSearch } from "../src/agents/web"
import {
  createModelCatalog,
  defineLanguageModel,
  type LanguageModel,
  type WebSearchModel,
} from "../src/models"
import { createAiModelCallLimitController } from "../src/models/execution/model-call-limits"
import { AiModelCallRecorder } from "../src/models/execution/model-call-recorder"
import { InMemoryStorage } from "../src/storage"
import { createTestAgentExecution } from "../src/testing"
import { createTestRuntimeDeps } from "./test-runtime-deps"

const Room = defineObjectType({
  id: "Room",
  name: "Room",
  properties: [prop("id", "string", { required: true, primary: true })],
})

let projectRoot = ""
beforeAll(async () => {
  projectRoot = await mkdtemp(join(tmpdir(), "sixb-agent-web-"))
})
afterAll(async () => {
  await rm(projectRoot, { recursive: true, force: true })
})

const hit = { url: "https://example.com/a", title: "A", snippet: "About A" }

function searchModel(search: WebSearchModel["search"] = async () => ({ results: [hit] })) {
  return {
    providerId: "search",
    modelId: "web",
    definition: { kind: "web-search" as const, providerId: "search", modelId: "web" },
    search: mock(search),
  }
}

function languageModel(
  providerToolNames?: readonly string[],
  webSearch?: WebSearchModel
): LanguageModel {
  return {
    providerId: "test",
    modelId: "native",
    definition: defineLanguageModel({
      kind: "language",
      providerId: "test",
      modelId: "native",
      capabilities: {},
    }),
    ...(providerToolNames ? { providerToolNames } : {}),
    ...(webSearch ? { webSearch } : {}),
    stream: async () => {
      throw new Error("Unexpected language call")
    },
  }
}

function load(input: { readonly web?: unknown; readonly model?: LanguageModel } = {}) {
  return createSixb({
    projectRoot,
    ontologies: [Room],
    ...(input.model ? { models: { language: [input.model] } } : {}),
    agent: input.web === undefined ? {} : { web: input.web as AgentWebOptions },
    ...createTestRuntimeDeps(),
  })
}

describe("agent.web", () => {
  test("keeps its domains in canonical form, and refuses what is not a domain", async () => {
    // Proven by removal: drop resolveAgentWebOptions from resolveDefinitions; the raw list stays.
    const sixb = await load({
      web: { allowedDomains: ["Docs.Example.com.", "docs.example.com", "example.com/guides/"] },
    })
    expect(sixb.definitions.agent.web).toEqual({
      allowedDomains: ["docs.example.com", "example.com/guides"],
    })

    expect((await load({ web: false })).definitions.agent.web).toBe(false)

    for (const [web, message] of [
      [true, "agent.web must be false"],
      [{ allowDomains: ["example.com"] }, "unknown option 'allowDomains'"],
      [{ blockedDomains: [] }, "agent.web.blockedDomains must list from 1"],
      [{ allowedDomains: ["https://example.com"] }, "agent.web.allowedDomains has an invalid"],
      [{ allowedDomains: ["example.com:8080"] }, "agent.web.allowedDomains has an invalid"],
    ] as const) {
      const error = await load({ web }).catch((caught: unknown) => caught)
      expect(error).toBeInstanceOf(Error)
      expect((error as Error).message).toContain(message)
    }
  })

  test("refuses a provider tool that takes a web tool's name, unless web is off", async () => {
    // Proven by removal: drop the assertNoProviderWebTools call; the project then starts.
    const native = languageModel(["code_execution", "web_search"], searchModel())

    const refused = await load({ model: native }).catch((error: unknown) => error)
    expect((refused as Error).message).toBe(
      "[Sixb] Language model 'test/native' declares the provider tool 'web_search', a name Sixb gives the Agent's own web tool. Remove it from providerTools, or set agent.web: false to keep the provider's."
    )

    await expect(load({ model: native, web: false })).resolves.toBeDefined()
    await expect(load({ model: languageModel(["code_execution"]) })).resolves.toBeDefined()
  })

  test("leaves a provider's web_search alone when the project has no search backend", async () => {
    // Proven by removal: check web_search whatever models.webSearch holds in
    // assertNoProviderWebTools; this project then fails to start, though it offers no web_search.
    await expect(load({ model: languageModel(["web_search"]) })).resolves.toBeDefined()

    const fetching = await load({ model: languageModel(["web_fetch"]) }).catch((error) => error)
    expect((fetching as Error).message).toContain("declares the provider tool 'web_fetch'")
  })
})

describe("a run's web search", () => {
  async function accounting() {
    const storage = new InMemoryStorage()
    const projectId = "agent-web"
    const executionId = await createTestAgentExecution(storage, { projectId, runId: "run" })
    const recorder = new AiModelCallRecorder({
      storage,
      projectId,
      executionId,
      attempt: 1,
      requesterGroupIds: [],
      limits: createAiModelCallLimitController({ storage, projectId, requesterGroupIds: [] }),
      recoverAiModelCall: async () => {
        throw new Error("Unexpected recovery")
      },
    })
    return async () => recorder
  }

  test("stops when its run is cancelled", async () => {
    // Proven by removal: drop execution.signal from the signal bindAgentWebSearch hands the
    // search; it then returns its hits after the run was cancelled.
    let release = () => {}
    const released = new Promise<void>((resolve) => {
      release = resolve
    })
    let started = () => {}
    const searching = new Promise<void>((resolve) => {
      started = resolve
    })
    let seen: AbortSignal | undefined
    const model = searchModel(async (request) => {
      seen = request.signal
      started()
      await released
      return { results: [hit] }
    })

    const run = new AbortController()
    const search = bindAgentWebSearch(
      { agent: {}, models: createModelCatalog({ webSearch: [model] }) },
      { signal: run.signal, accounting: await accounting() }
    )
    const pending = search({ query: "q", maxResults: 3 }, new AbortController().signal).catch(
      (error) => error
    )

    await searching
    run.abort()
    expect(seen?.aborted).toBe(true)

    release()
    expect(await pending).toMatchObject({ name: "AbortError" })
  })

  test("is refused when agent.web is false, though the project has a search model", async () => {
    // Proven by removal: drop the agent.web check in bindAgentWebSearch; a runner's session then
    // searches for an Agent that offers no web tools.
    const model = searchModel()
    const search = bindAgentWebSearch(
      { agent: { web: false }, models: createModelCatalog({ webSearch: [model] }) },
      { signal: new AbortController().signal, accounting: await accounting() }
    )

    const refused = await search({ query: "q", maxResults: 3 }, new AbortController().signal).catch(
      (error) => error
    )

    expect(refused).toMatchObject({
      code: "agent.execution_failed",
      message: "[Sixb] The Agent's web tools are off: agent.web is false.",
    })
    expect(model.search).not.toHaveBeenCalled()
  })
})

describe("the web tools' domain lists", () => {
  test("match exact hosts, subdomains of a wildcard and path prefixes; blocked wins", () => {
    const policy = webDomainPolicy({
      allowedDomains: ["example.com", "*.docs.dev", "site.org/guides"],
      blockedDomains: ["example.com/private"],
    })
    const refuses = (url: string) => policy.refuses(new URL(url))

    expect(refuses("https://EXAMPLE.com./a")).toBeUndefined()
    expect(refuses("https://api.docs.dev/x")).toBeUndefined()
    expect(refuses("https://site.org/guides/start")).toBeUndefined()

    expect(refuses("https://www.example.com/")).toBe("not-allowed")
    expect(refuses("https://docs.dev/")).toBe("not-allowed")
    expect(refuses("https://site.org/guidesx")).toBe("not-allowed")
    expect(refuses("https://example.com/private/key")).toBe("blocked")

    expect(webDomainPolicy({}).refuses(new URL("https://anything.test/"))).toBeUndefined()
  })
})

describe("the web tools' names", () => {
  // Proven by removal: drop AGENT_WEB_TOOL_NAMES from AGENT_RESERVED_TOOL_NAMES and its check; a
  // project tool then takes the name.
  test("are reserved, with what to do instead", () => {
    for (const name of ["web_search", "web_fetch"]) {
      expect(() => defineAgentTool(name)).toThrow(
        `[Sixb] Agent tool name '${name}' is reserved: Sixb gives the Agent its own ${name} tool. To search with Exa, set models.webSearch: [exaSearch(...)].`
      )
    }
  })
})
