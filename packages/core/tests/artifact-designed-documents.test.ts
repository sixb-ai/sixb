import { describe, expect, test } from "bun:test"
import type { ArtifactFile } from "../src"
import { ArtifactRequestError, SixbHost } from "../src"
import { frameStartHash } from "../src/artifacts"
import { injectFrameAssets, markDocumentSections } from "../src/artifacts/frames/assets"
import { frameEntries, frameLayout } from "../src/artifacts/frames/entries"
import { FRAME_DOCUMENT_CSS } from "../src/artifacts/frames/kit"
import { readDocumentPaper } from "../src/artifacts/paper"
import { emptyGrantIndex } from "../src/authorization/types"
import { createTestSixb } from "../src/testing"
import { createTestRuntimeDeps } from "./test-runtime-deps"

function setup() {
  const deps = createTestRuntimeDeps()
  const host = new SixbHost({ id: "documents", ontology: [], ...deps })
  const sixb = createTestSixb(host, {
    authorization: {
      principal: { type: "user", id: "alice" },
      groupIds: [],
      roleIds: [],
      grants: emptyGrantIndex(),
    },
  })
  const publish = async (contents: Record<string, string>) => {
    const files: ArtifactFile[] = []
    for (const [path, body] of Object.entries(contents)) {
      files.push({
        path,
        file: await deps.blobStorage.put({
          body: new TextEncoder().encode(body),
          fileName: path.split("/").at(-1) ?? path,
        }),
      })
    }
    return sixb.artifacts.create({ kind: "document", title: "Service proposal", files })
  }
  return { publish }
}

async function refusal(promise: Promise<unknown>): Promise<string> {
  const error = await promise.then(
    () => null,
    (caught: unknown) => caught
  )
  expect(error).toBeInstanceOf(ArtifactRequestError)
  return (error as Error).message
}

const PROPOSAL = [
  "<!doctype html><html lang='en'><head>",
  '<link rel="stylesheet" href="design.css">',
  '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter">',
  "<style>@page { margin: 0.75in 0.85in; }</style>",
  "</head><body><main class='proposal'>",
  "<header class='cover'><img class='logo' src='images/logo.svg' alt='Northwind'>",
  "<h1>Job flow &amp; scheduling</h1></header>",
  "<section><h2><span class='number'>1.</span> What changes</h2><p>One path.</p></section>",
  "<section><h2>Pricing</h2>",
  '<a href="artifact:art_k3m9q2x7tp">See the estimate</a>',
  "</section></main></body></html>",
].join("")

describe("publishing a designed document", () => {
  test("reads its HTML, its headings as the outline, and its paper from the @page rules", async () => {
    const { publish } = setup()
    const estimate = await publish({ "document.md": "# Estimate" })
    const published = await publish({
      "document.html": PROPOSAL.replace("art_k3m9q2x7tp", estimate.artifact.id),
      "design.css": "@page { size: letter; margin: 1in; } h1 { font-size: 29px; }",
      "images/logo.svg": "<svg xmlns='http://www.w3.org/2000/svg'/>",
    })

    expect(published.version.entry).toBe("document.html")
    expect(published.version.outline).toEqual({
      kind: "document",
      format: "html",
      headings: [
        { depth: 1, text: "Job flow & scheduling", slug: "job-flow-scheduling" },
        { depth: 2, text: "1. What changes", slug: "1-what-changes" },
        { depth: 2, text: "Pricing", slug: "pricing" },
      ],
      // Letter from the stylesheet, and the margins of the <style> after it.
      paper: { width: 816, height: 1056, margin: { top: 72, right: 81.6, bottom: 72, left: 81.6 } },
    })
    expect(published.version.references).toMatchObject([
      { address: `artifact:${estimate.artifact.id}`, as: "link", at: "pricing" },
    ])
  })

  test("has no paper when no @page rule sets a size", async () => {
    const { publish } = setup()
    const published = await publish({
      "document.html": "<h1>Notes</h1><style>@page { margin: 1in }</style>",
    })
    expect(published.version.outline).toEqual({
      kind: "document",
      format: "html",
      headings: [{ depth: 1, text: "Notes", slug: "notes" }],
    })
  })

  test("refuses what would run, and what it loads from outside the artifact", async () => {
    const { publish } = setup()
    const cases: [string, string][] = [
      ["<h1>Hi</h1><script>alert(1)</script>", "holds <script>"],
      ["<iframe src='https://example.com'></iframe>", "holds <iframe>"],
      ["<form><input></form>", "holds <form>"],
      ["<base href='https://example.com/'>", "holds <base>"],
      ["<p onclick='steal()'>Hi</p>", "the handler 'onclick'"],
      ["<a href=' javascript:steal()'>Hi</a>", "javascript: address"],
      ["<img src='https://example.com/logo.png'>", "not a file in the artifact"],
      ["<img src='images/missing.png'>", "not one of the artifact's files"],
      ["<link rel='stylesheet' href='https://example.com/x.css'>", "loads the stylesheet"],
    ]
    for (const [html, message] of cases) {
      expect(await refusal(publish({ "document.html": html }))).toContain(message)
    }
  })

  test("renders from one entry: refuses both, and names both when there is neither", async () => {
    const { publish } = setup()
    expect(
      await refusal(publish({ "document.md": "# Report", "document.html": "<h1>Report</h1>" }))
    ).toContain("not both")
    expect(await refusal(publish({ "notes.txt": "Report" }))).toContain(
      "or its HTML in 'document.html'"
    )
  })

  test("opens in the document layout, which serves its entry with the paper", () => {
    const outline = {
      kind: "document" as const,
      format: "html" as const,
      headings: [],
      paper: { width: 816, height: 1056, margin: { top: 72, right: 72, bottom: 72, left: 72 } },
    }
    expect(frameLayout({ outline })).toBe("document")
    expect(frameEntries({ entry: "document.html", outline })).toEqual(["document.html"])
    expect(
      injectFrameAssets("<html><head></head></html>", "document", "document.html", outline.paper)
    ).toContain(
      '<link rel="stylesheet" href="__sixb/document.css"><script src="__sixb/runtime.js" data-sixb-layout="document" data-sixb-paper="816 1056 72 72 72 72">'
    )
    // The stage's rules win over a document's own: it would otherwise draw the stage as its sheet.
    expect(FRAME_DOCUMENT_CSS).toContain("html.sixb-pages body {")
    expect(FRAME_DOCUMENT_CSS).toContain("background: var(--sixb-stage) !important;")
  })

  test("marks each heading with its section's slug, in order", () => {
    const html = "<h1>Title</h1><p>Lede</p><h2 class='x'>Scope</h2><h3>Scope</h3>"
    expect(
      markDocumentSections(html, [
        { depth: 1, text: "Title", slug: "title" },
        { depth: 2, text: "Scope", slug: "scope" },
        { depth: 3, text: "Scope", slug: "scope-1" },
      ])
    ).toBe(
      '<h1 data-sixb-section="title">Title</h1><p>Lede</p><h2 class=\'x\' data-sixb-section="scope">Scope</h2><h3 data-sixb-section="scope-1">Scope</h3>'
    )
  })

  test("starts as pages, at a section", () => {
    expect(frameStartHash({ pages: true, section: "pricing & terms" })).toBe(
      "#sixb-pages&sixb-section=pricing%20%26%20terms"
    )
  })
})

describe("a designed document's paper", () => {
  test("reads named sizes, orientation, lengths, and margins in any unit", () => {
    expect(readDocumentPaper(["@page { size: A4 landscape; margin: 20mm 15mm }"])).toEqual({
      width: 1122.52,
      height: 793.7,
      margin: { top: 75.59, right: 56.69, bottom: 75.59, left: 56.69 },
    })
    expect(readDocumentPaper(["@page{size:8.5in 11in;margin:0;margin-left:36pt}"])).toEqual({
      width: 816,
      height: 1056,
      margin: { top: 0, right: 0, bottom: 0, left: 48 },
    })
    expect(readDocumentPaper(["@page { size: 6in }"])?.height).toBe(576)
  })

  test("takes a later rule over an earlier one, and only unnamed rules for every page", () => {
    expect(
      readDocumentPaper([
        "@page { size: letter; margin: 1in }",
        "/* @page { size: a5 } */ @page :first { size: a3 } @page cover { size: a3 }",
        "@page { margin: 0.5in; @top-center { content: 'Draft'; margin: 3in } }",
      ])
    ).toEqual({ width: 816, height: 1056, margin: { top: 48, right: 48, bottom: 48, left: 48 } })
  })

  test("is none without a size it can measure", () => {
    expect(readDocumentPaper(["@page { margin: 1in }"])).toBeNull()
    expect(readDocumentPaper(["@page { size: auto }"])).toBeNull()
    expect(readDocumentPaper(["@page { size: 40em 60em }"])).toBeNull()
    expect(readDocumentPaper(["body { size: letter }"])).toBeNull()
  })
})
