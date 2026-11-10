import { describe, expect, test } from "bun:test"
import type { ListArtifactHoldersResponse } from "@sixb/client"
import { listArtifactHoldersQueryKey, listObjectTypesQueryKey } from "@sixb/client/hooks"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { renderToStaticMarkup } from "react-dom/server"
import { MemoryRouter } from "react-router-dom"
import { ArtifactHolders } from "../src/artifacts/holders"

const PLAN = "art_k3m9q2x7tp"

const holder = (primaryId: string, title?: string) => ({
  objectTypeId: "ServiceContract",
  primaryId,
  propertyId: "onboardingPlan",
  ...(title ? { title } : {}),
})

function render(holders: ListArtifactHoldersResponse | undefined): string {
  const cache = new QueryClient({ defaultOptions: { queries: { enabled: false } } })
  if (holders)
    cache.setQueryData(listArtifactHoldersQueryKey({ path: { artifactId: PLAN } }), holders)
  cache.setQueryData(listObjectTypesQueryKey(), [
    {
      id: "ServiceContract",
      name: "Service contract",
      properties: [{ id: "onboardingPlan", name: "onboardingPlan", schema: "artifactRef" }],
      links: [],
      actions: [],
    },
  ])

  return renderToStaticMarkup(
    <QueryClientProvider client={cache}>
      <MemoryRouter>
        <ArtifactHolders artifactId={PLAN} />
      </MemoryRouter>
    </QueryClientProvider>
  )
}

describe("the objects an artifact belongs to", () => {
  test("names the one that holds it, by its title and property, and opens its page", () => {
    const markup = render({
      holders: [holder("contract-camden-priority", "NLM-23077")],
      hasMore: false,
    })
    expect(markup).toContain('href="/objects/ServiceContract/contract-camden-priority"')
    expect(markup).toContain("NLM-23077 · Onboarding Plan")
    expect(markup).toContain('aria-label="Belongs to NLM-23077 · Onboarding Plan"')
  })

  test("names an object without a title by its type and key", () => {
    const markup = render({ holders: [holder("contract-camden-priority")], hasMore: false })
    expect(markup).toContain("Service contract contract-camden-priority · Onboarding Plan")
  })

  test("counts the others, and those past the first page", () => {
    const markup = render({
      holders: [
        holder("contract-camden-priority", "NLM-23077"),
        holder("contract-delaware", "NLM-24061"),
      ],
      hasMore: true,
    })
    expect(markup).toContain('aria-label="Belongs to 2+ objects"')
    expect(markup).toContain("+2")
  })

  // Nothing while the holders load, and nothing when no object the reader sees holds it.
  test("shows nothing until an object it belongs to is known", () => {
    expect(render(undefined)).toBe("")
    expect(render({ holders: [], hasMore: false })).toBe("")
  })
})
