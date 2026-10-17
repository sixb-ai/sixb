import { describe, expect, test } from "bun:test"
import type { GetArtifactVersionResponse } from "@sixb/client"
import { getArtifactVersionQueryKey } from "@sixb/client/hooks"
import { parseCsv } from "@sixb/core/artifacts"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type { ReactNode } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { MemoryRouter } from "react-router-dom"
import { ArtifactPanelRoot } from "../src/agent/artifact-panel"
import { AssistantBody } from "../src/agent/components/message-parts"
import type { NormalizedPart, NormalizedTool } from "../src/agent/parts"
import { turnArtifacts, unpublishedTitles } from "../src/agent/publish-artifact/interpret"
import { PublishArtifactToolView } from "../src/agent/publish-artifact/publish-artifact-tool-view"
import { versionChanges, versionSummary } from "../src/artifacts/card-details"
import { documentOpening, previewColumns } from "../src/artifacts/card-preview"
import { artifactFileSource } from "../src/artifacts/file-source"
import { en as artifactsEn } from "../src/artifacts/messages"
import { fileSheetModel } from "../src/artifacts/renderers/sheet/model"

function publish(artifactId: string, version: number, title: string): NormalizedPart {
  return {
    kind: "tool",
    tool: {
      toolName: version === 1 ? "publish_artifact" : "publish_artifact_version",
      state: "output-available",
      input: { path: "work/review", title },
      output: { artifactId, version, kind: "document", title, warnings: [] },
    },
  }
}

function refused(input: Record<string, unknown>): NormalizedPart {
  return {
    kind: "tool",
    tool: {
      toolName: "id" in input ? "publish_artifact_version" : "publish_artifact",
      state: "output-error",
      input: { path: "work/review", ...input },
      errorText: "[SixbAgentWorker] publish_artifact refused: there is nothing to publish.",
    },
  }
}

function render(node: ReactNode): string {
  const queryClient = new QueryClient({ defaultOptions: { queries: { enabled: false } } })
  return renderToStaticMarkup(
    <QueryClientProvider client={queryClient}>{node}</QueryClientProvider>
  )
}

describe("what a turn published", () => {
  const parts: NormalizedPart[] = [
    publish("art_review0001", 1, "Q3 review draft"),
    { kind: "text", text: "Drafted it; tightening the numbers." },
    publish("art_brief00001", 1, "Board brief"),
    publish("art_review0001", 2, "Q3 review"),
    { kind: "text", text: "Both are ready." },
  ]

  test("is one card per artifact, at the last version the turn published", () => {
    expect(turnArtifacts(parts).map((artifact) => [artifact.artifactId, artifact.version])).toEqual(
      [
        ["art_review0001", 2],
        ["art_brief00001", 1],
      ]
    )

    const html = render(<AssistantBody parts={parts} />)
    expect(html).toContain('aria-label="Published in this response"')
    expect(html.match(/aria-label="Open /g)).toHaveLength(2)
    expect(html).toContain('aria-label="Open Q3 review"')
    // The turn created both, so both are cards; a card says what it is, not which version.
    expect(turnArtifacts(parts).map((artifact) => artifact.created)).toEqual([true, true])
    expect(html).not.toContain("Q3 review draft")
    // The cards close the answer, after its text.
    expect(html.indexOf("Both are ready.")).toBeLessThan(html.indexOf("Published in this response"))
  })

  test("keeps every publish in the work, with its version, warnings, or refusal", () => {
    const warned: NormalizedTool = {
      toolName: "publish_artifact",
      state: "output-available",
      input: { title: "Q3 review" },
      output: {
        artifactId: "art_review0001",
        version: 3,
        kind: "document",
        title: "Q3 review",
        warnings: [{ code: "contrast", message: "Low contrast text.", part: "risks" }],
      },
    }
    const refused: NormalizedTool = {
      toolName: "publish_artifact",
      state: "output-error",
      input: { title: "Q3 review" },
      errorText:
        "[SixbAgentWorker] publish_artifact refused: document.md shows the image 'chart.svg', which is not one of the artifact's files.",
    }

    const published = render(<PublishArtifactToolView tool={warned} />)
    expect(published).toContain("Published Q3 review")
    expect(published).toContain("· v3")
    expect(published).toContain("risks: Low contrast text.")

    const failed = render(<PublishArtifactToolView tool={refused} />)
    expect(failed).toContain("Couldn&#x27;t publish Q3 review")
    expect(failed).toContain(
      "document.md shows the image &#x27;chart.svg&#x27;, which is not one of the artifact&#x27;s files."
    )
    expect(failed).not.toContain("[SixbAgentWorker]")
  })
})

describe("an artifact's cards across turns", () => {
  test("only the card of the version that is open reads as open", () => {
    // Reproduce by letting useIsOpen match on the artifact alone: both cards read as open.
    const html = render(
      <MemoryRouter>
        <ArtifactPanelRoot
          scopeKey="thread"
          routeTarget={{ type: "artifact", artifactId: "art_review0001", version: 3 }}
          onRouteTargetChange={() => {}}
        >
          <AssistantBody parts={[publish("art_review0001", 2, "Q3 review")]} />
          <AssistantBody parts={[publish("art_review0001", 3, "Q3 review")]} />
        </ArtifactPanelRoot>
      </MemoryRouter>
    )
    const pressed = [...html.matchAll(/aria-pressed="(true|false)"/g)].map((match) => match[1])
    expect(pressed).toEqual(["false", "true"])
  })
})

describe("what a turn could not publish", () => {
  test("is said where the card would be, once the turn is over", () => {
    // Reproduce by dropping the NotPublished blocks from AssistantBody: only the work, collapsed,
    // would show the refusals, and the answer may still claim the deliverable is ready.
    const parts: NormalizedPart[] = [
      refused({ kind: "document", title: "Q3 review" }),
      refused({ kind: "document", title: "Q3 review" }),
      { kind: "text", text: "I prepared the Q3 review." },
    ]
    expect(render(<AssistantBody parts={parts} />)).toContain("Couldn&#x27;t publish Q3 review")
    expect(render(<AssistantBody parts={parts} live />)).not.toContain("Couldn&#x27;t publish")
    expect(unpublishedTitles(parts)).toEqual(["Q3 review"])
  })

  test("is only what no later publish replaced", () => {
    expect(
      unpublishedTitles([
        refused({ kind: "document", title: "Q3 review" }),
        publish("art_review0001", 1, "Q3 review"),
      ])
    ).toEqual([])
    // A revision that failed after the first version still failed.
    expect(
      unpublishedTitles([
        publish("art_review0001", 1, "Q3 review"),
        refused({ id: "art_review0001", title: "Q3 review, final" }),
      ])
    ).toEqual(["Q3 review, final"])
  })
})

describe("an artifact card's preview", () => {
  /** A card for version 1 of an artifact whose files the cache already holds. */
  function card(kind: "document" | "sheet", texts: Record<string, string>): string {
    const artifactId = "art_preview001"
    const queryClient = new QueryClient({
      defaultOptions: { queries: { enabled: false, staleTime: Number.POSITIVE_INFINITY } },
    })
    const files = Object.keys(texts).map((path, index) => ({
      path,
      file: {
        blobId: `blob-${index}`,
        digest: `sha256:${String(index).padStart(64, "0")}`,
        sizeBytes: texts[path]?.length ?? 0,
        mediaType: path.endsWith(".csv") ? "text/csv" : "text/plain",
      },
    }))
    queryClient.setQueryData(getArtifactVersionQueryKey({ path: { artifactId, version: "1" } }), {
      artifactId,
      version: 1,
      title: "Q3 numbers",
      entry: kind === "sheet" ? "workbook.json" : "document.md",
      files,
      outline:
        kind === "sheet"
          ? { kind, sheets: [{ name: "Summary", rows: 2, columns: [] }], charts: [] }
          : { kind, headings: [] },
      references: [],
      author: { type: "user", id: "user-1" },
      createdAt: "2026-10-02T12:00:00.000Z",
    } satisfies GetArtifactVersionResponse)
    for (const { path, file } of files) {
      const source = artifactFileSource({ artifactId, version: 1, path, fileRef: file })
      queryClient.setQueryData([...source.queryKey, "text"], texts[path])
    }
    const parts: NormalizedPart[] = [
      {
        kind: "tool",
        tool: {
          toolName: "publish_artifact",
          state: "output-available",
          input: { title: "Q3 numbers" },
          output: { artifactId, version: 1, kind, title: "Q3 numbers", warnings: [] },
        },
      },
    ]
    return renderToStaticMarkup(
      <QueryClientProvider client={queryClient}>
        <AssistantBody parts={parts} />
      </QueryClientProvider>
    )
  }

  test("shows a sheet's first rows, formatted for a glance", () => {
    const html = card("sheet", {
      "workbook.json": JSON.stringify({
        sheets: [{ name: "Summary", columns: { Revenue: "currency", Margin: "percent" } }],
      }),
      "sheets/Summary.csv":
        "Quarter,Notes,Revenue,Margin\nQ4 2025,Renewals,4120000,0.269\nQ3 2026,Enterprise,5560000,0.351\n",
    })
    expect(html).toContain(">Quarter<")
    expect(html).toContain(">$4.12M<")
    expect(html).toContain(">35.1%<")
    // Notes is text, and the preview has room for three columns: the numbers win. Reproduce by
    // taking the first three columns in previewColumns: Notes shows, and Margin does not.
    expect(html).not.toContain(">Renewals<")
    expect(html).toContain(">Sheet · 2 rows<")
  })

  test("sets a document's title and lede", () => {
    const html = card("document", {
      "document.md":
        "# Q3 report\n\nRevenue grew **18%** on [renewals](#renewals).\n\n## Revenue\n",
    })
    expect(html).toContain(">Q3 report<")
    expect(html).toContain(">Revenue grew 18% on renewals.<")
  })

  test("reads a lede that opens in bold, the way the Agent writes a report's front matter", () => {
    // Reproduce by letting a leading `*` end the lede, as a list marker would: the preview is
    // only the title.
    expect(
      documentOpening("# Q3 review\n\n**Northline**  \n**Period:** July to September\\\nEnd.")
    ).toEqual({ title: "Q3 review", lede: "Northline Period: July to September End." })
  })

  test("reads a document's opening as its page does", () => {
    expect(documentOpening("Intro\n\n# Title\n\nThe lede,\nwrapped.\n\nMore.")).toEqual({
      title: "Title",
      lede: "The lede, wrapped.",
    })
    // What follows the title is the lede only when it is a paragraph.
    expect(documentOpening("# Title\n\n![Chart](chart.svg)\n\nText.")).toEqual({ title: "Title" })
    expect(documentOpening("# Title\n\n- one\n- two")).toEqual({ title: "Title" })
    expect(documentOpening("No heading at all.")).toEqual({})
  })

  test("keeps the column naming each row, then numbers, in the sheet's order", () => {
    const model = (csv: string) => fileSheetModel("table.csv", parseCsv(csv))
    expect(previewColumns(model("Part,SKU,Category,On hand,Cost\nA,B,C,1,2\n"))).toEqual([0, 3, 4])
    expect(previewColumns(model("Region,Visits,Owner,Notes\nNorth,1,Ana,x\n"))).toEqual([0, 1, 2])
    expect(previewColumns(model("Name\nA\n"))).toEqual([0])
  })
})

describe("an artifact a turn revised", () => {
  const version = (
    outline: GetArtifactVersionResponse["outline"],
    files: GetArtifactVersionResponse["files"] = [],
    entry = "workbook.json"
  ): GetArtifactVersionResponse => ({
    artifactId: "art_preview001",
    version: 1,
    title: "Q3 numbers",
    entry,
    files,
    outline,
    references: [],
    author: { type: "user", id: "user-1" },
    createdAt: "2026-10-02T12:00:00.000Z",
  })
  const sheets = (names: string[], charts: string[] = []) =>
    version({
      kind: "sheet",
      sheets: names.map((name) => ({ name, rows: 4, columns: [] })),
      charts,
    })
  const sections = (names: string[]) =>
    version({
      kind: "document",
      headings: [
        { depth: 1, text: "Q3 review", slug: "q3-review" },
        ...names.map((name) => ({ depth: 2, text: name, slug: name.toLowerCase() })),
      ],
    })

  test("is a line, since its card is already in the conversation", () => {
    const parts = [
      publish("art_review0001", 1, "Q3 review"),
      publish("art_review0001", 3, "Q3 review"),
    ]
    expect(turnArtifacts(parts)[0]?.created).toBe(true)
    const revision = [publish("art_review0001", 3, "Q3 review")]
    expect(turnArtifacts(revision)[0]?.created).toBe(false)
    const html = render(<AssistantBody parts={revision} />)
    expect(html).toContain(">Version 3<")
    expect(html).toContain('aria-label="Open Q3 review"')
  })

  test("says what its version added and removed, read from the structure", () => {
    expect(
      versionChanges(
        sheets(["Overview", "Cases"]),
        sheets(["Overview", "Cases", "Charts"], ["a", "b", "c"]),
        artifactsEn
      )
    ).toEqual(["Added Charts", "Added 3 charts"])
    expect(versionChanges(sheets(["A", "B", "C"]), sheets(["A"]), artifactsEn)).toEqual([
      "Removed 2 sheets",
    ])
    expect(
      versionChanges(
        sections(["Summary", "Risks"]),
        sections(["Summary", "Visuals", "Exposure"]),
        artifactsEn
      )
    ).toEqual(["Added 2 sections", "Removed Risks"])
    // Edits inside a section leave the structure as it was.
    expect(versionChanges(sections(["Summary"]), sections(["Summary"]), artifactsEn)).toEqual([])
  })

  test("describes what an artifact holds by its kind", () => {
    expect(versionSummary(sheets(["Overview", "Cases"], ["a"]), artifactsEn, "en")).toBe(
      "Sheet · 2 sheets · 1 chart"
    )
    expect(versionSummary(sheets(["Overview"]), artifactsEn, "en")).toBe("Sheet · 4 rows")
    expect(versionSummary(sections(["Summary", "Risks"]), artifactsEn, "en")).toBe(
      "Document · 2 sections"
    )
    const pdf = version(
      { kind: "file", mediaType: "application/pdf" },
      [
        {
          path: "report.pdf",
          file: {
            blobId: "b",
            digest: `sha256:${"0".repeat(64)}`,
            sizeBytes: 24_576,
            mediaType: "application/pdf",
          },
        },
      ],
      "report.pdf"
    )
    expect(versionSummary(pdf, artifactsEn, "en")).toBe("PDF · 24 KB")
  })
})
