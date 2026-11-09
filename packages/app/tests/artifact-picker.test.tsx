import { afterAll, afterEach, describe, expect, mock, test } from "bun:test"
import { client, type ListArtifactsResponse } from "@sixb/client"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { fireEvent, render, waitFor } from "@testing-library/react"
import type { ReactNode } from "react"
import {
  ArtifactPicker,
  ArtifactPickerList,
  artifactIdIn,
  titleMatches,
} from "../src/pages/console/ontology/components/artifact-picker"
import { installDom } from "./helpers/dom"

installDom([
  "document",
  "navigator",
  "Node",
  "Element",
  "HTMLElement",
  "Event",
  "EventTarget",
  "MouseEvent",
  "KeyboardEvent",
  "FocusEvent",
  "PointerEvent",
  "MutationObserver",
  "ResizeObserver",
  "getComputedStyle",
  "matchMedia",
  "requestAnimationFrame",
  "cancelAnimationFrame",
])

const originalConfig = client.getConfig()
client.setConfig({ baseUrl: "https://api.sixb.test" })

afterEach(() => {
  client.setConfig({ fetch: originalConfig.fetch })
})

afterAll(() => {
  client.setConfig({ baseUrl: originalConfig.baseUrl })
})

type Summary = ListArtifactsResponse["artifacts"][number]

const artifact = (id: string, kind: Summary["kind"], title: string): Summary => ({
  id,
  projectId: "northline",
  kind,
  title,
  owner: { type: "user", id: "usr_1" },
  latestVersion: 1,
  revision: 1,
  createdAt: "2026-11-02T10:00:00.000Z",
  updatedAt: "2026-11-08T10:00:00.000Z",
})

const plan = artifact("art_p1an000000", "canvas", "Harbor Point onboarding plan")
const review = artifact("art_rev1ew0000", "document", "Q3 operations review")
const elsewhere = artifact("art_e1sewhere0", "sheet", "Parts inventory")
// Shared with the reader through an object they read, not one they may change.
const readOnly = artifact("art_r3adon1y00", "document", "Pricing terms")

/** The list holds the plan and the review; any one artifact is read by its id. */
function serve(): string[] {
  const requests: string[] = []
  const known = new Map([plan, review, elsewhere, readOnly].map((each) => [each.id, each]))
  client.setConfig({
    fetch: (async (request: Request) => {
      const url = new URL(request.url)
      requests.push(`${url.pathname}${url.search}`)

      if (url.pathname === "/api/artifacts") {
        return Response.json({ artifacts: [plan, review], hasMore: false, total: 2 })
      }

      const id = url.pathname.split("/").pop() ?? ""
      const found = known.get(id)
      return found
        ? Response.json({
            artifact: found,
            versions: [],
            access: found === readOnly ? "read" : "owner",
          })
        : Response.json({ error: "[Sixb] Not found.", code: "artifact_not_found" }, { status: 404 })
    }) as typeof fetch,
  })
  return requests
}

function withQueryClient({ children }: { readonly children: ReactNode }) {
  return <QueryClientProvider client={new QueryClient()}>{children}</QueryClientProvider>
}

function renderPicker(value: string, onChange: (artifactId: string) => void = () => {}) {
  return render(<ArtifactPicker id="plan" value={value} onChange={onChange} />, {
    wrapper: withQueryClient,
  })
}

/** The list the picker opens, as a popover or a sheet shows it: Radix opens neither in this process. */
function renderList(chosenId: string, onChoose: (artifactId: string) => void = () => {}) {
  const chosen = [plan, review, elsewhere].find((each) => each.id === chosenId)
  return render(<ArtifactPickerList chosenId={chosenId} chosen={chosen} onChoose={onChoose} />, {
    wrapper: withQueryClient,
  })
}

function typeInSearch(text: string) {
  const input = document.querySelector<HTMLInputElement>("[cmdk-input]")
  if (!input) throw new Error("[SixbAppTest] The picker has no search.")
  // React reads typing from focus and key events around the input.
  fireEvent.focusIn(input)
  fireEvent.input(input, { target: { value: text } })
  fireEvent.keyUp(input, { key: text.at(-1) })
}

const options = () =>
  Array.from(document.querySelectorAll("[cmdk-item]")).map((item) => item.textContent ?? "")

describe("the artifact picker", () => {
  test("names the chosen artifact by its title", async () => {
    serve()
    const view = renderPicker(plan.id)
    await waitFor(() =>
      expect(view.getByRole("combobox").textContent).toBe("Harbor Point onboarding plan")
    )
  })

  test("lists the chosen artifact first, searches by title, and chooses one", async () => {
    serve()
    const onChange = mock((_: string) => {})
    renderList(review.id, onChange)

    await waitFor(() => expect(options()).toHaveLength(2))
    expect(options()[0]).toStartWith("Q3 operations review")

    typeInSearch("harbor plan")
    await waitFor(() => expect(options()).toHaveLength(1))
    expect(options()[0]).toStartWith("Harbor Point onboarding plan")

    const [row] = document.querySelectorAll("[cmdk-item]")
    if (!row) throw new Error("[SixbAppTest] No artifact to choose.")
    fireEvent.click(row)
    expect(onChange).toHaveBeenCalledWith(plan.id)
  })

  // Regression proof: leave a pasted link to the title search and it matches nothing.
  test("offers the artifact a pasted link opens, and says when it opens none", async () => {
    serve()
    renderList("")
    await waitFor(() => expect(options()).toHaveLength(2))

    typeInSearch(`https://app.northline.test/artifacts/${elsewhere.id}?v=2`)
    await waitFor(() => expect(options()).toEqual([expect.stringContaining("Parts inventory")]))

    typeInSearch("https://app.northline.test/artifacts/art_g0ne000000")
    await waitFor(() =>
      expect(document.body.textContent).toContain(
        "This link doesn't open an artifact you can read."
      )
    )
  })
})

// Regression proof: drop the `read` branch from the "From the link" group and the read-only
// artifact is offered, then refused by the server as if it did not exist.
test("shows an artifact the reader can only read, and why, without offering it", async () => {
  serve()
  renderList("")
  await waitFor(() => expect(options()).toHaveLength(2))

  typeInSearch(`https://app.northline.test/artifacts/${readOnly.id}`)
  await waitFor(() =>
    expect(document.body.textContent).toContain("You can read this one, not change it.")
  )

  expect(document.body.textContent).toContain("Pricing terms")
  expect(options()).toEqual([])
})

describe("reading what was typed", () => {
  test("finds an artifact in its page's link, a conversation's, or its id alone", () => {
    expect(artifactIdIn("https://app.test/artifacts/art_k3m9q2x7tp?v=2#top")).toBe("art_k3m9q2x7tp")
    expect(artifactIdIn("/threads/thr_1?artifact=art_k3m9q2x7tp&part=a")).toBe("art_k3m9q2x7tp")
    expect(artifactIdIn(" art_k3m9q2x7tp ")).toBe("art_k3m9q2x7tp")
    expect(artifactIdIn("art plan")).toBeNull()
    expect(artifactIdIn("https://app.test/artifacts/art_short")).toBeNull()
  })

  test("matches every word of a search, whatever its case and accents", () => {
    expect(titleMatches("Plan d’intégration Harbor Point", "INTEGRATION harbor")).toBe(true)
    expect(titleMatches("Harbor Point onboarding plan", "harbor review")).toBe(false)
  })
})
