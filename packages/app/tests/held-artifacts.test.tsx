import { describe, expect, test } from "bun:test"
import { SixbApiError } from "@sixb/client"
import { getArtifactVersionQueryKey } from "@sixb/client/hooks"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { renderToStaticMarkup } from "react-dom/server"
import { MemoryRouter } from "react-router-dom"
import {
  ArtifactCardsContext,
  fieldRecordSchema,
  ValuePanel,
  valueSchema,
} from "../src/pages/values"
import { artifactVersion, seedVersion } from "./helpers/artifacts"

const PLAN = "art_k3m9q2x7tp"
const NOTES = "art_n0tes00000"

const plan = artifactVersion({
  artifactId: PLAN,
  title: "Harbor Point onboarding plan",
  entry: "index.md",
  outline: { kind: "document", headings: [{ depth: 2, text: "Week one", slug: "week-one" }] },
  frozen: false,
})

const schema = valueSchema(
  fieldRecordSchema({
    onboardingPlan: "artifactRef",
    attachments: { type: "array", items: "artifactRef" },
  })
)

/** The latest version as a card reads it, settled as a failure. */
function failLatest(cache: QueryClient, artifactId: string, error: Error) {
  cache
    .getQueryCache()
    .build(cache, {
      queryKey: getArtifactVersionQueryKey({ path: { artifactId, version: "latest" } }),
    })
    .setState({ status: "error", error, fetchStatus: "idle" })
}

function render(value: unknown, cache: QueryClient, cards: boolean): string {
  return renderToStaticMarkup(
    <QueryClientProvider client={cache}>
      <MemoryRouter>
        <ArtifactCardsContext.Provider value={cards}>
          <ValuePanel title="Properties" value={value} schema={schema} />
        </ArtifactCardsContext.Provider>
      </MemoryRouter>
    </QueryClientProvider>
  )
}

function cacheWithPlan(): QueryClient {
  const cache = new QueryClient({ defaultOptions: { queries: { enabled: false } } })
  seedVersion(cache, plan, {}, { as: "latest" })
  return cache
}

describe("an artifact an object holds", () => {
  test("is a card on the object's page that opens it, and a chip elsewhere", () => {
    const cache = cacheWithPlan()

    const card = render({ onboardingPlan: { type: "artifact", id: PLAN } }, cache, true)
    expect(card).toContain(`href="/artifacts/${PLAN}"`)
    expect(card).toContain("Harbor Point onboarding plan")
    expect(card).toContain("Document · 1 section")

    const chip = render({ onboardingPlan: { type: "artifact", id: PLAN } }, cache, false)
    expect(chip).toContain(`href="/artifacts/${PLAN}"`)
    expect(chip).toContain("Harbor Point onboarding plan")
    expect(chip).not.toContain("Document · 1 section")
  })

  // Regression proof: drop the list branch from Field and the cards are numbered rows of a tree.
  test("lines a list of artifacts up as cards rather than numbered rows", () => {
    const cache = cacheWithPlan()
    const markup = render(
      {
        attachments: [
          { type: "artifact", id: PLAN },
          { type: "artifact", id: PLAN },
        ],
      },
      cache,
      true
    )
    expect(markup.match(new RegExp(`href="/artifacts/${PLAN}"`, "g"))).toHaveLength(2)
    expect(markup).toContain("2 items")
    expect(markup).not.toMatch(/<dt[^>]*>1<\/dt>/)
  })

  test("holds its place while it loads", () => {
    const cache = new QueryClient({ defaultOptions: { queries: { enabled: false } } })
    const markup = render({ onboardingPlan: { type: "artifact", id: PLAN } }, cache, true)
    expect(markup).toContain('role="status"')
    expect(markup).toContain('aria-label="Loading…"')
    expect(markup).not.toContain("href=")
  })

  test("says in a reader's words when it is gone or not theirs, never with its id", () => {
    const cache = new QueryClient({ defaultOptions: { queries: { enabled: false } } })
    failLatest(cache, PLAN, new SixbApiError("not found", { status: 404 }))
    failLatest(
      cache,
      NOTES,
      new SixbApiError("not shared", { status: 403, body: { code: "not_shared" } })
    )

    const gone = render({ onboardingPlan: { type: "artifact", id: PLAN } }, cache, true)
    expect(gone).toContain("No longer available")
    expect(gone).not.toContain(PLAN)
    expect(gone).not.toContain("href=")

    const notShared = render({ onboardingPlan: { type: "artifact", id: NOTES } }, cache, true)
    expect(notShared).toContain("Not shared with you")
    expect(notShared).not.toContain(NOTES)

    const chip = render({ onboardingPlan: { type: "artifact", id: PLAN } }, cache, false)
    expect(chip).toContain("No longer available")
    expect(chip).not.toContain(PLAN)
  })

  // Regression proof: show the card whenever a version was read and a deleted plan stays on the
  // object's page until it is reloaded.
  test("gives way when the artifact is deleted while the page shows it, and not on a failed read", () => {
    const deleted = cacheWithPlan()
    failLatest(deleted, PLAN, new SixbApiError("not found", { status: 404 }))
    const gone = render({ onboardingPlan: { type: "artifact", id: PLAN } }, deleted, true)
    expect(gone).toContain("No longer available")
    expect(gone).not.toContain("href=")

    const offline = cacheWithPlan()
    failLatest(offline, PLAN, new SixbApiError("unavailable", { status: 503 }))
    const kept = render({ onboardingPlan: { type: "artifact", id: PLAN } }, offline, true)
    expect(kept).toContain(`href="/artifacts/${PLAN}"`)
  })

  test("offers to try again when reading it failed", () => {
    const cache = new QueryClient({ defaultOptions: { queries: { enabled: false } } })
    failLatest(cache, PLAN, new SixbApiError("unavailable", { status: 503 }))
    const markup = render({ onboardingPlan: { type: "artifact", id: PLAN } }, cache, true)
    expect(markup).toContain("Couldn&#x27;t load this artifact")
    expect(markup).toContain("Try again")
  })
})
