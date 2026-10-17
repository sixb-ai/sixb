import { describe, expect, test } from "bun:test"
import type { GetArtifactVersionResponse } from "@sixb/client"
import { getArtifactVersionQueryKey } from "@sixb/client/hooks"
import { Markdown } from "@sixb/ui/components"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { renderToStaticMarkup } from "react-dom/server"
import { artifactFileSource } from "../src/artifacts/file-source"
import { artifactUrlTransform, rehypeKeepSection } from "../src/artifacts/references/embed-tree"
import {
  ArtifactReferencesProvider,
  ReferencingMarkdown,
} from "../src/artifacts/references/references"
import { rehypeArtifactDocument } from "../src/artifacts/renderers/document-tree"

const NUMBERS = "art_q3n4mbers0"
const REVIEW = "art_rev1ew0000"
const digest = (seed: string) => `sha256:${seed.padEnd(64, "0").slice(0, 64)}`

function version(
  artifactId: string,
  outline: GetArtifactVersionResponse["outline"],
  texts: Record<string, string>,
  entry: string
): GetArtifactVersionResponse {
  return {
    artifactId,
    version: 2,
    title: artifactId === NUMBERS ? "Q3 numbers" : "Q3 review",
    entry,
    files: Object.entries(texts).map(([path, text]) => ({
      path,
      file: {
        blobId: `${artifactId}/${path}`,
        digest: digest(`${artifactId}${path}`.replace(/[^0-9a-f]/g, "a")),
        sizeBytes: text.length,
        mediaType: path.endsWith(".csv") ? "text/csv" : "text/plain",
      },
    })),
    outline,
    references: [],
    author: { type: "user", id: "user-1" },
    createdAt: "2026-10-02T12:00:00.000Z",
  }
}

const sheet = {
  "workbook.json": JSON.stringify({
    sheets: [{ name: "Regions", columns: { Visits: "number", "Within SLA": "percent" } }],
  }),
  "sheets/Regions.csv":
    "Region,Visits,Within SLA\nNorth,1284,0.961\nCentral,962,0.934\nSouth,1107,0.918\n",
}
const review = {
  "document.md": [
    "# Q3 review",
    "",
    "## Parts cost",
    "",
    "Parts cost per visit fell.",
    "",
    `![Regions](artifact:${NUMBERS}#Regions!A1:C2)`,
    "",
    "## Risks",
    "",
    "Compressors.",
  ].join("\n"),
}

/** Markdown as a reply renders it, with both artifacts' latest versions already read. */
function render(markdown: string): string {
  const cache = new QueryClient({
    defaultOptions: { queries: { enabled: false, retry: false, staleTime: Infinity } },
  })
  const seed = (record: GetArtifactVersionResponse, texts: Record<string, string>) => {
    cache.setQueryData(
      getArtifactVersionQueryKey({ path: { artifactId: record.artifactId, version: "latest" } }),
      record
    )
    for (const file of record.files) {
      const source = artifactFileSource({
        artifactId: record.artifactId,
        version: record.version,
        path: file.path,
        fileRef: file.file,
      })
      cache.setQueryData([...source.queryKey, "text"], texts[file.path])
    }
  }
  seed(
    version(
      NUMBERS,
      {
        kind: "sheet",
        sheets: [{ name: "Regions", rows: 3, columns: ["Region", "Visits", "Within SLA"] }],
        charts: [],
      },
      sheet,
      "workbook.json"
    ),
    sheet
  )
  seed(
    version(
      REVIEW,
      {
        kind: "document",
        headings: [
          { depth: 1, text: "Q3 review", slug: "q3-review" },
          { depth: 2, text: "Parts cost", slug: "parts-cost" },
          { depth: 2, text: "Risks", slug: "risks" },
        ],
      },
      review,
      "document.md"
    ),
    review
  )
  return renderToStaticMarkup(
    <QueryClientProvider client={cache}>
      <ArtifactReferencesProvider open={() => {}}>
        <ReferencingMarkdown>{markdown}</ReferencingMarkdown>
      </ArtifactReferencesProvider>
    </QueryClientProvider>
  )
}

describe("an artifact shown in a reply or a document", () => {
  test("shows a sheet's range as a table, formatted as the sheet formats it", () => {
    const html = render(`Regions:\n\n![Regions, Q3](artifact:${NUMBERS}#Regions!A1:C3)\n`)
    expect(html).toContain('<table class="sixb-embed-table')
    expect(html).toContain(">1,284<")
    expect(html).toContain(">96.1%<")
    // A1:C3 is the header and two rows.
    expect(html).toContain(">Central<")
    expect(html).not.toContain(">South<")
    expect(html).toContain("<figcaption")
    expect(html).toContain(">Regions, Q3<")
    expect(html).toContain("Q3 numbers · Latest")
  })

  test("shows only what it is, and inline it is a link", () => {
    const html = render(`See ![the regions](artifact:${NUMBERS}#Regions) here.`)
    expect(html).not.toContain("<table")
    expect(html).toContain(`href="/artifacts/${NUMBERS}?part=Regions"`)
    expect(html).toContain(">the regions</a>")
  })

  test("shows a document's section, where an embed one level down is a link", () => {
    // Reproduce by not counting depth in ArtifactEmbed: the section's own embed shows a table.
    const html = render(`![](artifact:${REVIEW}#parts-cost)`)
    expect(html).toContain("Parts cost per visit fell.")
    expect(html).not.toContain("Compressors.")
    expect(html).not.toContain("<table")
    expect(html).toContain(`href="/artifacts/${NUMBERS}?part=Regions%21A1%3AC2"`)
  })

  test("says a part is unavailable when its artifact no longer has it", () => {
    const html = render(`![Old](artifact:${NUMBERS}#chart=old)`)
    expect(html).toContain("Unavailable")
    expect(html).toContain("This part is no longer in “Q3 numbers”.")
  })

  test("keeps artifact addresses and still strips unsafe links", () => {
    expect(artifactUrlTransform(`artifact:${NUMBERS}#Regions`)).toBe(`artifact:${NUMBERS}#Regions`)
    expect(artifactUrlTransform("javascript:alert(1)")).toBe("")
    expect(artifactUrlTransform("https://example.com")).toBe("https://example.com")
  })
})

describe("a document's section", () => {
  const section = (markdown: string, slug: string) =>
    renderToStaticMarkup(
      <Markdown rehypePlugins={[rehypeArtifactDocument, rehypeKeepSection(slug)]}>
        {markdown}
      </Markdown>
    )

  test("runs from its heading to the next one at its depth or above, as the page names them", () => {
    const markdown = [
      "# Title",
      "",
      "Revenue & cost",
      "--------------",
      "",
      "Text.",
      "",
      "```md",
      "## Not a heading",
      "```",
      "",
      "### Detail",
      "",
      "More.",
      "",
      "## Risks",
      "",
      "Last.",
    ].join("\n")
    // A setext heading is a heading too, and its slug is the one publishing gave it.
    const html = section(markdown, "revenue-cost")
    expect(html).toContain('id="revenue-cost"')
    expect(html).toContain("Text.")
    expect(html).toContain("## Not a heading")
    expect(html).toContain("More.")
    expect(html).not.toContain("Last.")
    expect(html).not.toContain("Title")
    expect(section(markdown, "risks")).toContain("Last.")
    expect(section(markdown, "missing")).not.toContain("Text.")
  })
})
