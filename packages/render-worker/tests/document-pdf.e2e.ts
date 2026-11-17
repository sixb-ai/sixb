import { describe, expect, test } from "bun:test"
import { existsSync } from "node:fs"
import {
  type ArtifactFile,
  InMemoryBlobStorage,
  InMemoryBroker,
  InMemoryLakeStorage,
  InMemoryQueues,
  InMemoryStorage,
  SixbHost,
} from "@sixb/core"
import { documentPdfKey } from "@sixb/core/internal/artifacts/publish"
import { emptyGrantIndex } from "@sixb/core/internal/authorization"
import { createTestSixb } from "@sixb/core/testing"
import { LocalSandboxFactory } from "@sixb/sandboxes-local"
import { printDocumentPdf } from "../src/document-pdf"

// A designed document printed in a real headless Chromium, through Playwright for Node as the agent
// image ships it: at /opt/sixb/js/node_modules/playwright, or where SIXB_PLAYWRIGHT points (with
// SIXB_CHROMIUM naming a browser when Playwright has none of its own). Without either it skips.
//
//   SIXB_PLAYWRIGHT=<dir>/node_modules/playwright-core \
//   bun test ./packages/render-worker/tests/document-pdf.e2e.ts
const IMAGE_PLAYWRIGHT = "/opt/sixb/js/node_modules/playwright"
const playwright =
  process.env.SIXB_PLAYWRIGHT ?? (existsSync(IMAGE_PLAYWRIGHT) ? IMAGE_PLAYWRIGHT : "")

describe.skipIf(!playwright)("a designed document printed in a browser", () => {
  test(
    "prints on its paper, its pages where its CSS breaks them",
    async () => {
      // Reproduce by dropping the kit's print rules: the sheet's padding and margins print inside
      // the paper's margins, and each section, 9.4in of the 10in between them, runs onto a page
      // of its own.
      const section = (title: string) =>
        `<section class="page"><h2>${title}</h2><p>A line of the proposal.</p></section>`
      const html = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<link rel="stylesheet" href="design.css"></head>
<body><section class="cover page"><h1>Proposal</h1></section>${section("Scope")}${section("Pricing")}</body></html>`
      const css = `@page { size: letter; margin: 0.5in } body { font: 10pt/1.4 Helvetica, Arial, sans-serif }
.page { height: 9.4in; margin: 0 } .page + .page { break-before: page }
.cover { background: #132a33; color: #fff }`

      const blobStorage = new InMemoryBlobStorage()
      const storage = new InMemoryStorage()
      const sandboxes = new LocalSandboxFactory({
        isolation: "none",
        env: {
          SIXB_PLAYWRIGHT: playwright,
          ...(process.env.SIXB_CHROMIUM ? { SIXB_CHROMIUM: process.env.SIXB_CHROMIUM } : {}),
        },
      })
      const host = new SixbHost({
        id: "pdfs",
        ontology: [],
        storage,
        blobStorage,
        sandboxes,
        queues: new InMemoryQueues(),
        broker: new InMemoryBroker(),
        lakeStorage: new InMemoryLakeStorage(),
      })
      const sixb = createTestSixb(host, {
        authorization: {
          principal: { type: "user", id: "alice" },
          groupIds: [],
          roleIds: [],
          grants: emptyGrantIndex(),
        },
      })
      const put = async (path: string, body: string): Promise<ArtifactFile> => ({
        path,
        file: await blobStorage.put({ body: new TextEncoder().encode(body), fileName: path }),
      })
      const { artifact, version } = await sixb.artifacts.create({
        kind: "document",
        title: "Proposal",
        files: [await put("document.html", html), await put("design.css", css)],
      })

      await printDocumentPdf({
        host,
        job: {
          id: "job",
          projectId: "pdfs",
          createdAt: new Date().toISOString(),
          availableAt: new Date().toISOString(),
          attempt: 1,
          type: "artifact.pdf.requested",
          payload: {
            artifactId: artifact.id,
            version: version.version,
            renderKey: documentPdfKey(version) ?? "",
          },
        },
        signal: AbortSignal.timeout(90_000),
      })

      const pdf = await sixb.artifacts.pdf(artifact.id)
      if (pdf?.status !== "ready") throw new Error(`Expected the PDF: ${JSON.stringify(pdf)}`)
      expect(pdf.pages).toBe(3)
      const bytes = Buffer.from(
        await new Response(await blobStorage.open(pdf.file.blobId)).arrayBuffer()
      )
      expect(bytes.subarray(0, 5).toString()).toBe("%PDF-")
      // Letter, in points, as its @page rule sets it.
      expect(bytes.toString("latin1")).toMatch(/\/MediaBox \[0 0 612 792\]/)
    },
    { timeout: 120_000 }
  )
})
