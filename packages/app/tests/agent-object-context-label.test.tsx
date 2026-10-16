import { afterEach, describe, expect, test } from "bun:test"
import { client } from "@sixb/client"
import { type AgentContextInput, agentContextIdentity } from "@sixb/core/agents/context"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { renderToStaticMarkup } from "react-dom/server"
import { ContextChips } from "../src/agent/components/context-chips"
import { objectContextTitleQuery } from "../src/agent/object-context-title"

const ref = { objectTypeId: "Invoice", primaryId: "inv-1" }

afterEach(() => {
  client.setConfig({ baseUrl: undefined, fetch: undefined })
})

function mockApi(responses: Record<string, Response | (() => Response)>): string[] {
  const requested: string[] = []
  const fetchMock = Object.assign(
    async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const request = input instanceof Request && !init ? input : new Request(input, init)
      const path = new URL(request.url).pathname
      requested.push(path)
      const response = responses[path]
      if (!response) return Response.json({ error: "Not found" }, { status: 404 })
      return typeof response === "function" ? response() : response.clone()
    },
    { preconnect: fetch.preconnect }
  ) satisfies typeof fetch
  client.setConfig({ baseUrl: "http://localhost", fetch: fetchMock })
  return requested
}

const invoiceType = (search?: { title?: string }) =>
  Response.json({ id: "Invoice", name: "Invoice", properties: [], links: [], actions: [], search })

function renderChips(context: AgentContextInput, queryClient = new QueryClient()): string {
  return renderToStaticMarkup(
    <QueryClientProvider client={queryClient}>
      <ContextChips entries={[{ context, origin: "ambient" }]} />
    </QueryClientProvider>
  )
}

describe("object context title", () => {
  test("reads the title from the type's search.title property", async () => {
    const requested = mockApi({
      "/api/object-types/Invoice": invoiceType({ title: "name" }),
      "/api/objects/Invoice/inv-1": Response.json({
        objectTypeId: "Invoice",
        primaryId: "inv-1",
        properties: { id: "inv-1", name: " July maintenance " },
      }),
      "/api/objects/Invoice/inv-2": Response.json({
        objectTypeId: "Invoice",
        primaryId: "inv-2",
        properties: { id: "inv-2", name: "August maintenance" },
      }),
    })
    const queryClient = new QueryClient()

    await expect(queryClient.fetchQuery(objectContextTitleQuery(queryClient, ref))).resolves.toBe(
      "July maintenance"
    )
    await queryClient.fetchQuery(
      objectContextTitleQuery(queryClient, { objectTypeId: "Invoice", primaryId: "inv-2" })
    )
    // The type is read once for every object of that type.
    expect(requested.filter((path) => path === "/api/object-types/Invoice")).toHaveLength(1)
  })

  test("resolves nothing without a title property, and fails without access", async () => {
    const requested = mockApi({ "/api/object-types/Invoice": invoiceType() })
    const queryClient = new QueryClient()
    await expect(
      queryClient.fetchQuery(objectContextTitleQuery(queryClient, ref))
    ).resolves.toBeNull()
    expect(requested).toEqual(["/api/object-types/Invoice"])

    mockApi({
      "/api/object-types/Invoice": invoiceType({ title: "name" }),
      "/api/objects/Invoice/inv-1": () => Response.json({ error: "Forbidden" }, { status: 403 }),
    })
    const denied = new QueryClient()
    await expect(denied.fetchQuery(objectContextTitleQuery(denied, ref))).rejects.toBeDefined()
  })
})

describe("context chips", () => {
  test("show an explicit label without looking the object up", () => {
    // Proven by removal: drop the explicit-label branch from agentContextLabel.
    const queryClient = new QueryClient()
    queryClient.setQueryData(objectContextTitleQuery(queryClient, ref).queryKey, "Resolved title")

    const html = renderChips({ kind: "object", ref, label: "July maintenance" }, queryClient)

    expect(html).toContain("July maintenance")
    expect(html).not.toContain("Resolved title")
  })

  test("show the object's title once it is known, and the id label until then", () => {
    // Proven by removal: return agentContextLabel() from useAgentContextLabel.
    const titled = new QueryClient()
    titled.setQueryData(objectContextTitleQuery(titled, ref).queryKey, "July maintenance")
    expect(renderChips({ kind: "object", ref }, titled)).toContain("July maintenance")

    const untitled = new QueryClient()
    untitled.setQueryData(objectContextTitleQuery(untitled, ref).queryKey, null)
    expect(renderChips({ kind: "object", ref }, untitled)).toContain("Invoice · Inv 1")
    expect(renderChips({ kind: "object", ref })).toContain("Invoice · Inv 1")
  })

  test("a label leaves the context identity unchanged", () => {
    expect(agentContextIdentity({ kind: "object", ref, label: "July maintenance" })).toBe(
      agentContextIdentity({ kind: "object", ref })
    )
  })
})
