import { describe, expect, test } from "bun:test"
import type { GetArtifactResponse, GetArtifactVersionResponse } from "@sixb/client"
import { getArtifactQueryKey } from "@sixb/client/hooks"
import { ARTIFACT_LIMITS } from "@sixb/core/artifacts"
import { Markdown } from "@sixb/ui/components"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type { ReactNode } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { MemoryRouter, Route, Routes } from "react-router-dom"
import { validateDocument } from "../../core/src/artifacts/publish/validate/document"
import type { ArtifactFile } from "../../core/src/storage/artifacts/types"
import { ArtifactPage } from "../src/artifacts/artifact-page"
import { fileView } from "../src/artifacts/file-view"
import { rehypeArtifactDocument } from "../src/artifacts/renderers/document-tree"
import {
  artifactLink,
  artifactTargetFromSearch,
  type ViewerTarget,
  withArtifactTarget,
} from "../src/artifacts/target"
import { Viewer } from "../src/artifacts/viewer"
import { artifactHref } from "../src/pages/routes"
import { seedVersion } from "./helpers/artifacts"

const ARTIFACT_ID = "art_0123456789"

describe("artifact targets", () => {
  test("round-trip through the conversation URL beside other parameters", () => {
    const params = withArtifactTarget(new URLSearchParams("tab=work"), {
      type: "artifact",
      artifactId: ARTIFACT_ID,
      version: 2,
      part: "revenue",
    })
    expect(params.toString()).toBe(`tab=work&artifact=${ARTIFACT_ID}&v=2&part=revenue`)
    expect(artifactTargetFromSearch(params)).toEqual({
      type: "artifact",
      artifactId: ARTIFACT_ID,
      version: 2,
      part: "revenue",
    })
    expect(withArtifactTarget(params, null).toString()).toBe("tab=work")
  })

  test("read a malformed version as the latest", () => {
    for (const version of ["0", "-1", "1.5", "two"]) {
      expect(
        artifactTargetFromSearch(new URLSearchParams({ artifact: ARTIFACT_ID, v: version }))
      ).toEqual({ type: "artifact", artifactId: ARTIFACT_ID })
    }
    expect(artifactTargetFromSearch(new URLSearchParams("v=2"))).toBeNull()
  })

  test("link to their page, pinned to a version only when it is not the latest", () => {
    const target = { type: "artifact", artifactId: ARTIFACT_ID } as const
    const origin = "https://ops.example.com"
    expect(artifactLink({ ...target, version: 3 }, 3, origin)).toBe(
      `https://ops.example.com/artifacts/${ARTIFACT_ID}`
    )
    expect(artifactLink({ ...target, version: 2, part: "q3" }, 3, origin)).toBe(
      `https://ops.example.com/artifacts/${ARTIFACT_ID}?v=2&part=q3`
    )
    expect(artifactHref(ARTIFACT_ID, { version: 2, part: "q3" })).toBe(
      `/artifacts/${ARTIFACT_ID}?v=2&part=q3`
    )
  })
})

describe("file views", () => {
  test.each([
    [{ mediaType: "image/png" }, "image"],
    [{ mediaType: "image/svg+xml" }, "image"],
    [{ mediaType: "application/pdf" }, "pdf"],
    [{ mediaType: "text/markdown; charset=utf-8" }, "markdown"],
    [{ mediaType: "text/csv" }, "csv"],
    [{ mediaType: "application/json" }, "text"],
    // A generic type defers to the name.
    [{ mediaType: "application/octet-stream", fileName: "regions.TSV" }, "tsv"],
    [{ fileName: "notes.md" }, "markdown"],
    // HTML runs no script here; it waits for the page kind.
    [{ mediaType: "text/html" }, "download"],
    [{ mediaType: "application/zip", fileName: "notes.md" }, "download"],
  ] as const)("%o shows as %s", (fileRef, view) => {
    expect(fileView(fileRef)).toBe(view)
  })
})

describe("document shaping", () => {
  const markdown = [
    "# Q3 operating review",
    "",
    "Revenue grew while costs held flat.",
    "",
    "## Revenue & cost",
    "",
    "> [!WARNING]",
    "> Freight costs are estimates.",
    "",
    '![Revenue by region](figures/revenue.png "Revenue by region, Q3")',
    "",
    "| Region | Revenue | Change |",
    "| --- | --- | --- |",
    "| North | $1,234.5 | +12% |",
    "| South | (980) | (3.2%) |",
    "",
    "## Revenue & cost",
    "",
    "### Café `crème`",
    "",
    "> A plain quote stays a quote.",
  ].join("\n")

  const html = renderToStaticMarkup(
    <Markdown rehypePlugins={[rehypeArtifactDocument]}>{markdown}</Markdown>
  )

  test("makes the first heading the title and the paragraph after it the lede", () => {
    expect(html).toContain('<h1 class="sixb-document-title" id="q3-operating-review">')
    expect(html).toContain('<p class="sixb-document-lede">Revenue grew while costs held flat.</p>')
  })

  test("turns marked quotes into callouts and leaves plain quotes alone", () => {
    expect(html).toMatch(/<aside data-callout="warning">\s*<p>Freight costs are estimates\.<\/p>/)
    expect(html).toContain("<blockquote>")
    expect(html).not.toContain("[!WARNING]")
  })

  test("captions a titled image with its title", () => {
    expect(html).toContain(
      '<figure><img src="figures/revenue.png" alt="Revenue by region"/><figcaption>Revenue by region, Q3</figcaption></figure>'
    )
  })

  test("aligns columns of figures, not columns of names", () => {
    // Short cells also stay on one line; only the alignment class matters here.
    const cell = (tag: string, text: string) =>
      new RegExp(
        `<${tag} class="[^"]*\\bsixb-numeric\\b[^"]*">${text.replace(/[()%]/g, "\\$&")}</${tag}>`
      )
    expect(html).toMatch(cell("th", "Revenue"))
    expect(html).toMatch(cell("td", "(980)"))
    // Reproduce by matching `\)?` before the unit in NUMERIC_CELL: "(3.2%)" reads as text.
    expect(html).toMatch(cell("td", "(3.2%)"))
    expect(html).not.toMatch(cell("td", "North"))
    expect(html).toContain(">North</td>")
  })

  test("gives headings the slugs publishing put in the outline", async () => {
    // A `#part` link only lands when the viewer's ids and the outline's slugs agree.
    const bytes = new TextEncoder().encode(markdown)
    const file: ArtifactFile = {
      path: "document.md",
      file: { blobId: "doc", digest: `sha256:${"a".repeat(64)}`, sizeBytes: bytes.byteLength },
    }
    const image: ArtifactFile = {
      path: "figures/revenue.png",
      file: { blobId: "png", digest: `sha256:${"b".repeat(64)}`, sizeBytes: 1 },
    }
    const { outline } = await validateDocument(
      {
        stat: async () => null,
        open: async () => new Blob([bytes]).stream(),
      },
      [file, image]
    )
    const slugs = outline.kind === "document" ? outline.headings.map((h) => h.slug) : []
    expect(slugs).toEqual(["q3-operating-review", "revenue-cost", "revenue-cost-1", "café-crème"])
    for (const slug of slugs) expect(html).toContain(`id="${slug}"`)
  })
})

describe("the viewer", () => {
  const fileRef = (blobId: string, sizeBytes: number, mediaType: string) => ({
    blobId,
    digest: `sha256:${blobId.padEnd(64, "0")}`,
    sizeBytes,
    mediaType,
  })

  function render(input: {
    readonly kind: GetArtifactResponse["artifact"]["kind"]
    readonly files: GetArtifactVersionResponse["files"]
    readonly entry: string
    readonly texts?: Record<string, string>
    readonly target?: ViewerTarget
    /** The version to seed; the artifact's latest is 2. */
    readonly version?: number
  }): string {
    const cache = new QueryClient({
      defaultOptions: { queries: { enabled: false, retry: false, staleTime: Infinity } },
    })
    const versions = [2, 1].map((version) => ({
      version,
      title: "Q3 operating review",
      author: { type: "user" as const, id: "user-1" },
      createdAt: `2026-10-0${version}T12:00:00.000Z`,
    }))
    cache.setQueryData(getArtifactQueryKey({ path: { artifactId: ARTIFACT_ID } }), {
      artifact: {
        id: ARTIFACT_ID,
        projectId: "project",
        kind: input.kind,
        title: "Q3 operating review",
        owner: { type: "user", id: "user-1" },
        latestVersion: 2,
        createdAt: "2026-10-01T12:00:00.000Z",
        updatedAt: "2026-10-02T12:00:00.000Z",
      },
      versions,
      access: "owner",
    } satisfies GetArtifactResponse)
    const version: GetArtifactVersionResponse = {
      artifactId: ARTIFACT_ID,
      version: input.version ?? 2,
      title: "Q3 operating review",
      entry: input.entry,
      files: input.files,
      outline:
        input.kind === "document"
          ? {
              kind: "document",
              headings: [
                { depth: 1, text: "Q3 operating review", slug: "q3-operating-review" },
                { depth: 2, text: "Revenue", slug: "revenue" },
                { depth: 2, text: "Costs", slug: "costs" },
              ],
            }
          : input.kind === "sheet"
            ? { kind: "sheet", sheets: [], charts: [] }
            : { kind: "file", mediaType: input.files[0]?.file.mediaType ?? "" },
      references: [],
      author: { type: "user", id: "user-1" },
      createdAt: "2026-10-02T12:00:00.000Z",
    }
    seedVersion(cache, version, input.texts)
    return renderToStaticMarkup(
      <Wrap cache={cache}>
        <Viewer
          target={input.target ?? { type: "artifact", artifactId: ARTIFACT_ID }}
          onTargetChange={() => {}}
          chrome={{ onClose: () => {}, fullPageHref: artifactHref(ARTIFACT_ID) }}
        />
      </Wrap>
    )
  }

  test("shows a document under its header, in its own theme", () => {
    const html = render({
      kind: "document",
      entry: "document.md",
      files: [
        { path: "document.md", file: fileRef("doc", 120, "text/markdown") },
        { path: "theme.json", file: fileRef("theme", 60, "application/json") },
        { path: "figures/revenue.png", file: fileRef("png", 1_024, "image/png") },
      ],
      texts: {
        "document.md":
          "# Q3 operating review\n\nLede.\n\n## Revenue\n\n![Chart](./figures/revenue.png)\n\n## Costs\n",
        "theme.json": JSON.stringify({ mode: "dark", tokens: { "--primary": "#0f766e" } }),
      },
    })

    expect(html).toContain(">Q3 operating review</h2>")
    // The kind leads the title as a tile; the version is a pill beside it.
    expect(html).toContain('role="img" aria-label="Document"')
    expect(html).toContain("Version 2")
    expect(html).toContain(`href="/artifacts/${ARTIFACT_ID}"`)
    expect(html).toContain('aria-label="Copy link"')
    // The image resolves to the version's file, through the route that authorizes it.
    expect(html).toContain(
      `/api/artifacts/${ARTIFACT_ID}/versions/2/content?path=figures%2Frevenue.png&amp;disposition=inline`
    )
    expect(html).toMatch(/data-sixb-artifact="" class="[^"]* dark"/)
    expect(html).toContain('style="--primary:#0f766e"')
    expect(html).toContain('<nav aria-label="On this page"')
    expect(html).toContain('aria-label="Copy a link to “Revenue”"')
  })

  test("shows a file artifact as its type allows, at the version a link pinned", () => {
    // Only version 1 is read: reproduce by ignoring `target.version` in Viewer, which then waits
    // on the latest, version 2.
    const html = render({
      kind: "file",
      entry: "regions.csv",
      files: [{ path: "regions.csv", file: fileRef("csv", 40, "text/csv") }],
      texts: { "regions.csv": "Region,Revenue\nNorth,1234\nSouth,980\n" },
      target: { type: "artifact", artifactId: ARTIFACT_ID, version: 1 },
      version: 1,
    })
    expect(html).toContain("Region")
    expect(html).toContain("North")
    expect(html).toContain('role="img" aria-label="File"')
    expect(html).toContain("Version 1")
  })

  test("shows a sheet as a spreadsheet: its tabs, its typed columns, and its rows", () => {
    const html = render({
      kind: "sheet",
      entry: "workbook.json",
      files: [
        { path: "workbook.json", file: fileRef("workbook", 200, "application/json") },
        { path: "sheets/Summary.csv", file: fileRef("summary", 120, "text/csv") },
        { path: "sheets/Regions.csv", file: fileRef("regions", 80, "text/csv") },
      ],
      texts: {
        "workbook.json": JSON.stringify({
          sheets: [
            { name: "Summary", columns: { Revenue: "currency", Margin: "percent" } },
            { name: "Regions" },
          ],
          charts: [{ name: "revenue", type: "bar", sheet: "Summary", x: "Quarter", y: "Revenue" }],
        }),
        "sheets/Summary.csv":
          "Quarter,Revenue,Margin\nQ2 2026,4380000,0.281\nQ3 2026,5560000,0.351\n",
      },
    })

    expect(html).toContain('role="tablist"')
    expect(html).toMatch(/role="tab"[^>]*aria-selected="true"[^>]*>Summary</)
    expect(html).toMatch(/role="tab"[^>]*aria-selected="false"[^>]*>Regions</)
    // The sheet downloads from a menu: as its CSV, or the workbook as an .xlsx.
    expect(html).toMatch(/aria-haspopup="menu"[^>]*aria-label="Download"/)
    expect(html).toContain("$5,560,000")
    expect(html).toContain("35.1%")
    // The sheet bar: the open sheet's tab, then the status figures.
    expect(html).toContain(">2 rows<")
    expect(html).toContain("Row 1 frozen")
    // The workbook's entry is not a file a reader wants; the sheet's own downloads replace it.
    expect(html).not.toContain("workbook.json")
  })

  test("offers a sheet too large to read as its CSV, rather than saying it could not be read", () => {
    // Reproduce by dropping the `tooLarge` notice in WorkbookView: the sheet "could not be read".
    const html = render({
      kind: "sheet",
      entry: "workbook.json",
      files: [
        { path: "workbook.json", file: fileRef("workbook", 200, "application/json") },
        {
          path: "sheets/Visits.csv",
          file: fileRef("visits", ARTIFACT_LIMITS.maxSheetFileBytes + 1, "text/csv"),
        },
      ],
      texts: { "workbook.json": JSON.stringify({ sheets: [{ name: "Visits" }] }) },
    })
    expect(html).toContain("This sheet is too large to show here")
    expect(html).not.toContain("This sheet could not be read.")
    expect(html).toMatch(/download="Visits.csv"[^>]*>.*Download Visits as CSV/)
  })
})

test("an artifact's page is the whole window, with a way back and no panel controls", () => {
  const cache = new QueryClient({ defaultOptions: { queries: { enabled: false } } })
  const html = renderToStaticMarkup(
    <QueryClientProvider client={cache}>
      <MemoryRouter initialEntries={[`/artifacts/${ARTIFACT_ID}`]}>
        <Routes>
          <Route path="/artifacts/:artifactId" element={<ArtifactPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>
  )
  expect(html).toMatch(/class="fixed inset-0 /)
  expect(html).toContain('aria-label="Back"')
  expect(html).not.toContain('aria-label="Close"')
  expect(html).not.toContain('aria-label="Open full page"')
})

function Wrap({ cache, children }: { readonly cache: QueryClient; readonly children: ReactNode }) {
  return (
    <QueryClientProvider client={cache}>
      <MemoryRouter>{children}</MemoryRouter>
    </QueryClientProvider>
  )
}
