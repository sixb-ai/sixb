import { describe, expect, test } from "bun:test"
import type { GetArtifactVersionResponse } from "@sixb/client"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { render } from "@testing-library/react"
import { frameLinkKey } from "../src/artifacts/frame"
import { ArtifactReferencesProvider } from "../src/artifacts/references/references"
import {
  DesignedDocumentRenderer,
  isDesignedDocument,
} from "../src/artifacts/renderers/designed-document"
import { installDom } from "./helpers/dom"

const browser = installDom([
  "document",
  "navigator",
  "localStorage",
  "Node",
  "Element",
  "HTMLElement",
  "HTMLIFrameElement",
  "Event",
  "MessageEvent",
  "MouseEvent",
  "matchMedia",
  "WheelEvent",
  "EventTarget",
  "MutationObserver",
  "ResizeObserver",
  "getComputedStyle",
  "requestAnimationFrame",
  "cancelAnimationFrame",
])

const PAPER = { width: 816, height: 1056, margin: { top: 72, right: 72, bottom: 72, left: 72 } }

function documentVersion(paper: typeof PAPER | null = PAPER): GetArtifactVersionResponse {
  return {
    artifactId: "art_pr0p0sa1x0",
    version: 1,
    title: "Service proposal",
    entry: "document.html",
    files: [],
    outline: {
      kind: "document",
      format: "html",
      headings: [{ depth: 2, text: "Pricing", slug: "pricing" }],
      ...(paper ? { paper } : {}),
    },
    references: [],
    author: { type: "user", id: "user-1" },
    createdAt: "2026-11-11T12:00:00.000Z",
    updatedAt: "2026-11-11T12:00:00.000Z",
    revision: 1,
    frozen: true,
  }
}

function mount(version: GetArtifactVersionResponse, part?: string) {
  const cache = new QueryClient({ defaultOptions: { queries: { enabled: false, retry: false } } })
  cache.setQueryData(frameLinkKey(version), {
    path: "/api/artifact-frames/token/",
    expiresAt: "2026-11-11T13:00:00.000Z",
  })
  const ui = render(
    <QueryClientProvider client={cache}>
      <ArtifactReferencesProvider open={() => {}}>
        <DesignedDocumentRenderer version={version} {...(part ? { part } : {})} />
      </ArtifactReferencesProvider>
    </QueryClientProvider>
  )
  const frame = () => {
    const element = ui.container.querySelector("iframe")
    if (!element) throw new Error("Expected the document's frame.")
    return element
  }
  return { ui, frame }
}

describe("a designed document", () => {
  test("is told from a Markdown one by its outline", () => {
    expect(isDesignedDocument(documentVersion())).toBe(true)
    expect(isDesignedDocument({ outline: { kind: "document", headings: [] } })).toBe(false)
  })

  test("opens as its pages, with nothing to choose", () => {
    const { ui, frame } = mount(documentVersion())
    expect(frame().getAttribute("title")).toBe("Document Service proposal")
    expect(frame().getAttribute("src")).toEndWith(
      "/api/artifact-frames/token/document.html#sixb-pages"
    )
    expect(ui.queryAllByRole("button")).toEqual([])
  })

  test("is one sheet on a phone, where its pages would be too small to read", () => {
    browser.happyDOM.setViewport({ width: 390, height: 844 })
    try {
      const { frame } = mount(documentVersion())
      expect(frame().getAttribute("src")).toEndWith("/api/artifact-frames/token/document.html")
    } finally {
      browser.happyDOM.setViewport({ width: 1024, height: 768 })
    }
  })

  test("opens at the section an address names", () => {
    const { frame } = mount(documentVersion(), "pricing")
    expect(frame().getAttribute("src")).toEndWith("document.html#sixb-pages&sixb-section=pricing")
  })

  test("without paper, is one sheet", () => {
    const { frame } = mount(documentVersion(null))
    expect(frame().getAttribute("src")).toEndWith("/api/artifact-frames/token/document.html")
  })
})
