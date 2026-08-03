import { describe, expect, test } from "bun:test"
import { type AgentToolRunContext, defineConnector, noopLogger } from "@sixb/core"
import type { ExaClient, ExaConnector, ExaSearchRequest, ExaSearchResponse } from "../src"
import { type ExaWebSearchOptions, exaWebSearch } from "../src/agent-tools"

describe("Exa web_search agent tool", () => {
  test("keeps model input narrow and applies bounded defaults", async () => {
    let receivedRequest: ExaSearchRequest | undefined
    let receivedSignal: AbortSignal | undefined
    const { tool, execute } = harness({
      async search(request, options) {
        receivedRequest = request
        receivedSignal = options?.signal
        return response([result("https://sixb.ai", "current sixb information")])
      },
    })

    const output = await execute("  current Sixb release  ")

    expect(tool.name).toBe("web_search")
    expect(tool.input).toEqual({ query: "string" })
    expect(receivedRequest).toEqual({
      query: "current Sixb release",
      numResults: 5,
      contents: { text: { maxCharacters: 2_000 } },
    })
    expect(receivedSignal).toBeInstanceOf(AbortSignal)
    expect(output).toEqual({
      results: [
        {
          title: "Title for https://sixb.ai",
          url: "https://sixb.ai",
          text: "current sixb information",
        },
      ],
    })
  })

  test("reapplies result, per-result, and total text limits to provider output", async () => {
    const { execute } = harness(
      {
        search: async () =>
          response([
            result("https://one.example", "abcdef"),
            result("https://two.example", "uvwxyz"),
            result("https://three.example", "ignored"),
          ]),
      },
      { maxResults: 2, maxCharactersPerResult: 4, maxTotalCharacters: 6 }
    )

    const output = await execute("bounded")

    expect(output).toEqual({
      results: [
        {
          title: "Title for https://one.example",
          url: "https://one.example",
          text: "abcd",
        },
        {
          title: "Title for https://two.example",
          url: "https://two.example",
          text: "uv",
        },
      ],
    })
  })

  test("maps domain policy to Exa and snapshots developer configuration", async () => {
    const allowedDomains = [" docs.sixb.ai "]
    const deniedDomains = ["archive.example"]
    let receivedRequest: ExaSearchRequest | undefined
    const { execute } = harness(
      {
        async search(request) {
          receivedRequest = request
          return response([])
        },
      },
      { allowedDomains, deniedDomains }
    )
    allowedDomains[0] = "changed.example"
    deniedDomains[0] = "changed.example"

    await execute("domain filters")

    expect(receivedRequest).toMatchObject({
      includeDomains: ["docs.sixb.ai"],
      excludeDomains: ["archive.example"],
    })
  })

  test("normalizes metadata and includes request and cost information when available", async () => {
    const { execute } = harness({
      search: async () => ({
        results: [
          {
            id: "https://sixb.ai/docs",
            title: null,
            url: "https://sixb.ai/docs",
            author: " Sixb contributors ",
            publishedDate: " 2026-08-03 ",
            text: "Documentation",
          },
        ],
        requestId: " request-123 ",
        costDollars: {
          total: 0.008,
          search: { neural: 0.007 },
          internal: "must not reach the model",
        },
      }),
    })

    await expect(execute("metadata")).resolves.toEqual({
      results: [
        {
          title: "https://sixb.ai/docs",
          url: "https://sixb.ai/docs",
          author: "Sixb contributors",
          publishedDate: "2026-08-03",
          text: "Documentation",
        },
      ],
      requestId: "request-123",
      costDollars: { total: 0.008 },
    })
  })

  test("bounds provider-controlled metadata and drops overlong URLs", async () => {
    const longUrl = `https://example.com/${"u".repeat(4_100)}`
    const { execute } = harness(
      {
        search: async () => ({
          results: [
            result(longUrl, "ignored"),
            {
              id: "https://sixb.ai/docs",
              title: ` Title ${"t".repeat(600)} `,
              url: " https://sixb.ai/docs ",
              author: ` Author ${"a".repeat(400)} `,
              publishedDate: ` 2026-08-03${"d".repeat(150)} `,
              text: "Documentation",
            },
          ],
          requestId: ` request-${"r".repeat(300)} `,
        }),
      },
      { maxResults: 2 }
    )

    const output = (await execute("metadata limits")) as {
      results: Array<{ title: string; url: string; author: string; publishedDate: string }>
      requestId: string
    }

    expect(output.results).toHaveLength(1)
    expect(output.results[0]?.url).toBe("https://sixb.ai/docs")
    expect(output.results[0]?.title).toHaveLength(500)
    expect(output.results[0]?.author).toHaveLength(300)
    expect(output.results[0]?.publishedDate).toHaveLength(100)
    expect(output.requestId).toHaveLength(200)
  })

  test("rejects invalid limits and domain policies when the tool is defined", () => {
    const definition = defineConnector("exa", fakeConnector({ search: async () => response([]) }))

    expect(() => exaWebSearch(definition, [] as unknown as ExaWebSearchOptions)).toThrow(
      "web_search options must be an object"
    )

    for (const options of [
      { maxResults: 0 },
      { maxResults: 101 },
      { maxResults: 1.5 },
      { maxCharactersPerResult: 0 },
      { maxTotalCharacters: Number.POSITIVE_INFINITY },
      { timeoutMs: 0 },
    ]) {
      expect(() => exaWebSearch(definition, options)).toThrow("[SixbExa]")
    }
    expect(() => exaWebSearch(definition, { allowedDomains: [] })).toThrow(
      "allowedDomains must contain from 1 to 1200 domains"
    )
    expect(() => exaWebSearch(definition, { deniedDomains: [" "] })).toThrow(
      "deniedDomains entries must be non-empty strings"
    )
    for (const allowedDomains of [null, "", false]) {
      expect(() =>
        exaWebSearch(definition, { allowedDomains } as unknown as ExaWebSearchOptions)
      ).toThrow("allowedDomains must contain from 1 to 1200 domains")
    }
  })

  test("times out a provider request that does not observe cancellation", async () => {
    const started = Promise.withResolvers<void>()
    let receivedSignal: AbortSignal | undefined
    const { execute } = harness(
      {
        search(_request, options) {
          receivedSignal = options?.signal
          started.resolve()
          return new Promise(() => {})
        },
      },
      { timeoutMs: 10 }
    )
    const execution = execute("slow search")
    await started.promise

    await expect(execution).rejects.toThrow("web_search timed out after 10ms")
    expect(receivedSignal?.aborted).toBe(true)
  })

  test("times out connector resolution", async () => {
    const { execute } = harness(
      { search: async () => response([]) },
      { timeoutMs: 10 },
      new AbortController().signal,
      () => new Promise(() => {})
    )

    await expect(execute("slow connector")).rejects.toThrow("web_search timed out after 10ms")
  })

  test("passes run cancellation to a provider request that does not observe it", async () => {
    const started = Promise.withResolvers<void>()
    let receivedSignal: AbortSignal | undefined
    const controller = new AbortController()
    const cancellation = new Error("run cancelled")
    const { execute } = harness(
      {
        search(_request, options) {
          receivedSignal = options?.signal
          started.resolve()
          return new Promise(() => {})
        },
      },
      { timeoutMs: 1_000 },
      controller.signal
    )
    const execution = execute("cancel me")
    await started.promise

    controller.abort(cancellation)

    await expect(execution).rejects.toBe(cancellation)
    expect(receivedSignal?.aborted).toBe(true)
  })

  test("rejects blank and oversized queries before searching", async () => {
    let searches = 0
    const { execute } = harness({
      async search() {
        searches += 1
        return response([])
      },
    })

    await expect(execute("  ")).rejects.toThrow("web_search query must not be empty")
    await expect(execute("q".repeat(2_001))).rejects.toThrow(
      "web_search query must contain at most 2000 characters"
    )
    expect(searches).toBe(0)
  })
})

function harness(
  client: ExaClient,
  options: Parameters<typeof exaWebSearch>[1] = {},
  signal: AbortSignal = new AbortController().signal,
  resolveConnector: () => Promise<ExaClient> = async () => client
) {
  const definition = defineConnector("exa", fakeConnector(client))
  const tool = exaWebSearch(definition, options)
  const connector = (async (requestedDefinition: unknown) => {
    expect(requestedDefinition).toBe(definition)
    return resolveConnector()
  }) as AgentToolRunContext["connector"]

  return {
    tool,
    execute(query: string) {
      return tool.handler({
        input: { query },
        signal,
        run: { id: "run-1", agentId: "research", threadId: "thread-1" },
        connector,
        logger: noopLogger,
      })
    },
  }
}

function fakeConnector(client: ExaClient): ExaConnector {
  return {
    type: "exa",
    connect: () => client,
  }
}

function result(url: string, text: string) {
  return { id: url, title: `Title for ${url}`, url, text }
}

function response(results: ExaSearchResponse["results"]): ExaSearchResponse {
  return { results }
}
