import { describe, expect, test } from "bun:test"
import type { ArtifactFile } from "../src"
import { ArtifactRequestError, SixbHost } from "../src"
import {
  formatArtifactAddress,
  parseArtifactAddress,
  parseSheetPart,
} from "../src/artifacts/address"
import { type ArtifactAddressTarget, resolveArtifactAddress } from "../src/artifacts/resolve"
import { emptyGrantIndex } from "../src/authorization/types"
import { createTestSixb } from "../src/testing"
import { createTestRuntimeDeps } from "./test-runtime-deps"

const ID = "art_k3m9q2x7tp"

describe("artifact addresses", () => {
  test("name an artifact, a version, a file, or a part", () => {
    expect(parseArtifactAddress(`artifact:${ID}`)).toEqual({ artifactId: ID })
    expect(parseArtifactAddress(`artifact:${ID}@2#chart=revenue`)).toEqual({
      artifactId: ID,
      version: 2,
      part: "chart=revenue",
    })
    expect(parseArtifactAddress(`artifact:${ID}/figures/revenue%20chart.svg`)).toEqual({
      artifactId: ID,
      path: "figures/revenue chart.svg",
    })
    expect(parseArtifactAddress(`artifact:${ID}#Q3%20numbers!A1:D5`)).toEqual({
      artifactId: ID,
      part: "Q3 numbers!A1:D5",
    })
  })

  test("refuse what is not one", () => {
    for (const text of [
      "https://example.com",
      "artifact:",
      "artifact:art_short",
      `artifact:${ID}@0`,
      `artifact:${ID}@two`,
      `artifact:${ID}#`,
      `artifact:${ID}/../secret`,
      `artifact:${ID}/a//b`,
    ]) {
      expect(parseArtifactAddress(text)).toBeNull()
    }
  })

  test("are written so a Markdown link keeps them whole", () => {
    const address = { artifactId: ID, version: 3, part: "Q3 numbers (draft)!A1:B4" }
    const written = formatArtifactAddress(address)
    expect(written).toBe(`artifact:${ID}@3#Q3%20numbers%20%28draft%29!A1:B4`)
    expect(parseArtifactAddress(written)).toEqual(address)
  })

  test("name a sheet, a range in A1 notation, or a chart", () => {
    expect(parseSheetPart("Summary")).toEqual({ type: "sheet", sheet: "Summary" })
    expect(parseSheetPart("Summary!D5:a1")).toEqual({
      type: "sheet",
      sheet: "Summary",
      range: { top: 0, left: 0, bottom: 4, right: 3 },
    })
    expect(parseSheetPart("Summary!B2")?.type).toBe("sheet")
    expect(parseSheetPart("chart=revenue")).toEqual({ type: "chart", chart: "revenue" })
    expect(parseSheetPart("Summary!A0")).toBeNull()
  })
})

describe("resolving an address", () => {
  const sheet = {
    kind: "sheet" as const,
    outline: {
      kind: "sheet" as const,
      sheets: [{ name: "Summary", rows: 4, columns: ["Quarter", "Revenue", "Margin"] }],
      charts: ["revenue"],
    },
    files: [{ path: "workbook.json" }, { path: "sheets/Summary.csv" }],
  }
  const document = {
    kind: "document" as const,
    outline: {
      kind: "document" as const,
      headings: [
        { depth: 1, text: "Q3 review", slug: "q3-review" },
        { depth: 2, text: "Methodology", slug: "methodology" },
      ],
    },
    files: [{ path: "document.md" }, { path: "figures/a.svg" }],
  }
  const resolve = (
    part: string | undefined,
    target: ArtifactAddressTarget = sheet,
    path?: string
  ) =>
    resolveArtifactAddress(
      {
        artifactId: ID,
        ...(part === undefined ? {} : { part }),
        ...(path === undefined ? {} : { path }),
      },
      target
    )

  test("finds the sheet, range, chart, section, or file it names", () => {
    expect(resolve(undefined)).toEqual({ part: { type: "artifact" } })
    expect(resolve("Summary!A1:C5")).toMatchObject({ part: { type: "sheet", sheet: "Summary" } })
    expect(resolve("chart=revenue")).toEqual({ part: { type: "chart", chart: "revenue" } })
    expect(resolve("methodology", document)).toEqual({
      part: { type: "section", slug: "methodology" },
    })
    expect(resolve(undefined, document, "figures/a.svg")).toEqual({
      part: { type: "file", path: "figures/a.svg" },
    })
  })

  test("says what is missing and what the target has instead", () => {
    expect(resolve("Summry")).toEqual({
      problem: "has no sheet 'Summry'; its sheets are 'Summary'",
    })
    expect(resolve("Summary!A1:D5")).toEqual({
      problem: "has no range A1:D5 in sheet 'Summary', which has 5 rows and 3 columns",
    })
    expect(resolve("Summary!A6")).toMatchObject({ problem: expect.stringContaining("no range A6") })
    expect(resolve("chart=revnue")).toEqual({
      problem: "has no chart 'revnue'; its charts are 'revenue'",
    })
    expect(resolve("method", document)).toEqual({
      problem: "has no section 'method'; its sections are 'q3-review', 'methodology'",
    })
    expect(resolve(undefined, document, "figures/b.svg")).toEqual({
      problem: "has no file 'figures/b.svg'",
    })
    expect(
      resolve("x", { kind: "file", outline: { kind: "file", mediaType: "text/csv" }, files: [] })
    ).toEqual({ problem: "is a file, which has no parts to name" })
  })
})

const SUMMARY = "Quarter,Revenue,Margin\nQ2 2026,4710000,0.301\nQ3 2026,5560000,0.351\n"
const workbook = (charts: { name: string }[] = [{ name: "revenue" }]) =>
  JSON.stringify({
    sheets: [{ name: "Summary", columns: { Revenue: "currency", Margin: "percent" } }],
    charts: charts.map(({ name }) => ({
      name,
      type: "bar",
      sheet: "Summary",
      x: "Quarter",
      y: "Revenue",
    })),
  })

function setup() {
  const deps = createTestRuntimeDeps()
  const host = new SixbHost({ id: "references", ontology: [], ...deps })
  const as = (id: string) =>
    createTestSixb(host, {
      authorization: {
        principal: { type: "user", id },
        groupIds: [],
        roleIds: [],
        grants: emptyGrantIndex(),
      },
    })
  const put = async (contents: Record<string, string>): Promise<ArtifactFile[]> =>
    Promise.all(
      Object.entries(contents).map(async ([path, body]) => ({
        path,
        file: await deps.blobStorage.put({
          body: new TextEncoder().encode(body),
          fileName: path.split("/").at(-1) ?? path,
        }),
      }))
    )
  const numbers = async (user = "alice") =>
    as(user).artifacts.create({
      kind: "sheet",
      title: "Q3 numbers",
      files: await put({ "workbook.json": workbook(), "sheets/Summary.csv": SUMMARY }),
    })
  const report = async (markdown: string, user = "alice") =>
    as(user).artifacts.create({
      kind: "document",
      title: "Q3 report",
      files: await put({ "document.md": markdown }),
    })
  // No authorization context: system code, which reads every artifact in the project.
  const system = createTestSixb(host)
  return { as, put, numbers, report, system, storage: deps.storage }
}

async function refusal(promise: Promise<unknown>): Promise<string> {
  const error = await promise.then(
    () => null,
    (caught: unknown) => caught
  )
  expect(error).toBeInstanceOf(ArtifactRequestError)
  expect((error as ArtifactRequestError).code).toBe("invalid_artifact")
  return (error as Error).message
}

describe("publishing references", () => {
  test("records each address with where it sits and the version it resolved to", async () => {
    const { numbers, report } = setup()
    const sheet = await numbers()
    const id = sheet.artifact.id
    const published = await report(
      [
        "# Q3 report",
        "",
        `Revenue is in [the numbers](artifact:${id}).`,
        "",
        "## Revenue",
        "",
        `![Revenue by quarter](artifact:${id}#chart=revenue)`,
        "",
        `![Summary](artifact:${id}@1#Summary!A1:C3)`,
      ].join("\n")
    )
    expect(published.version.references).toEqual([
      { address: `artifact:${id}`, as: "link", at: "q3-report", resolvedVersion: 1 },
      { address: `artifact:${id}#chart=revenue`, as: "embed", at: "revenue", resolvedVersion: 1 },
      { address: `artifact:${id}@1#Summary!A1:C3`, as: "embed", at: "revenue", resolvedVersion: 1 },
    ])
  })

  test("reads addresses in a sheet's link and image columns, by cell", async () => {
    const { as, put, report } = setup()
    const target = await report("# Methodology\n\nHow we count.\n")
    const id = target.artifact.id
    const published = await as("alice").artifacts.create({
      kind: "sheet",
      title: "Sources",
      files: await put({
        "workbook.json": JSON.stringify({
          sheets: [{ name: "Sources", columns: { Source: "link" } }],
        }),
        "sheets/Sources.csv": `Name,Source\nMethod,artifact:${id}#methodology\nWeb,https://example.com\n`,
      }),
    })
    expect(published.version.references).toEqual([
      { address: `artifact:${id}#methodology`, as: "link", at: "Sources!B2", resolvedVersion: 1 },
    ])
  })

  test("refuses an address that resolves to nothing, saying where and why", async () => {
    const { numbers, report } = setup()
    const id = (await numbers()).artifact.id
    expect(await refusal(report(`# R\n\n## Revenue\n\n![x](artifact:${id}#chart=revnue)\n`))).toBe(
      `[Sixb] In 'revenue', 'artifact:${id}#chart=revnue': “Q3 numbers” has no chart 'revnue'; its charts are 'revenue'.`
    )
    expect(await refusal(report(`# R\n\n![x](artifact:${id}@4)\n`))).toContain(
      "“Q3 numbers” has no version 4"
    )
    expect(await refusal(report("# R\n\n![x](artifact:art_0000000000)\n"))).toContain(
      "names no artifact you can read"
    )
    expect(await refusal(report("# R\n\n[x](artifact:nope)\n"))).toContain(
      "is not an artifact address"
    )
  })

  test("resolves only artifacts the author can read", async () => {
    // Reproduce by dropping the owner check in resolveReferences: Bob's report publishes.
    const { numbers, report } = setup()
    const id = (await numbers("alice")).artifact.id
    expect(await refusal(report(`# R\n\n![x](artifact:${id})\n`, "bob"))).toContain(
      "names no artifact you can read"
    )
  })

  test("refuses an artifact that names itself", async () => {
    const { as, put, report } = setup()
    const first = await report("# R\n\nFirst.\n")
    const id = first.artifact.id
    const files = await put({ "document.md": `# R\n\nSee [the start](artifact:${id}#r).\n` })
    expect(
      await refusal(as("alice").artifacts.publish(id, { kind: "document", title: "R", files }))
    ).toContain("names the artifact being published")
  })
})

describe("a new version that breaks another artifact", () => {
  test("publishes, naming each artifact that follows it and what no longer resolves", async () => {
    const { as, put, numbers, report } = setup()
    const id = (await numbers()).artifact.id
    const follows = await report(`# Q3 report\n\n![Revenue](artifact:${id}#chart=revenue)\n`)
    await report(`# Pinned\n\n![Revenue](artifact:${id}@1#chart=revenue)\n`)

    const renamed = await as("alice").artifacts.publish(id, {
      kind: "sheet",
      title: "Q3 numbers",
      files: await put({
        "workbook.json": workbook([{ name: "revenue-by-quarter" }]),
        "sheets/Summary.csv": SUMMARY,
      }),
    })
    // The pinned report keeps showing version 1, so only the one that follows breaks. Reproduce
    // by warning about pinned addresses in brokenDependents: the pinned report is named too.
    expect(renamed.warnings).toEqual([
      {
        code: "reference_broken",
        message: `“Q3 report” (${follows.artifact.id}) shows artifact:${id}#chart=revenue, but version 2 has no chart 'revenue'; its charts are 'revenue-by-quarter'. Publish its next version with an address that resolves, or restore what it names.`,
      },
    ])
  })

  test("names no artifact its author cannot read", async () => {
    // Reproduce by dropping the owner check in brokenDependents: Alice is told about a report
    // that only system code can read.
    const { as, put, numbers, system } = setup()
    const id = (await numbers("alice")).artifact.id
    await system.artifacts.create({
      kind: "document",
      title: "Board pack",
      files: await put({
        "document.md": `# Board pack\n\n![Revenue](artifact:${id}#chart=revenue)\n`,
      }),
    })
    const renamed = await as("alice").artifacts.publish(id, {
      kind: "sheet",
      title: "Q3 numbers",
      files: await put({ "workbook.json": workbook([]), "sheets/Summary.csv": SUMMARY }),
    })
    expect(renamed.warnings).toEqual([])
  })

  test("still publishes when the check fails, since the version is stored by then", async () => {
    // Reproduce by letting brokenDependents throw out of publishArtifact: the publish fails though
    // its version is stored, and the Agent would publish it again.
    const { as, put, numbers, storage } = setup()
    const id = (await numbers()).artifact.id
    const artifacts = storage.artifacts
    if (!artifacts) throw new Error("Expected artifact storage.")
    artifacts.listReferencingVersions = async () => {
      throw new Error("storage is unavailable")
    }
    const warn = console.warn
    console.warn = () => {}
    try {
      const next = await as("alice").artifacts.publish(id, {
        kind: "sheet",
        title: "Q3 numbers",
        files: await put({ "workbook.json": workbook(), "sheets/Summary.csv": SUMMARY }),
      })
      expect(next.version.version).toBe(2)
      expect(next.warnings).toEqual([])
    } finally {
      console.warn = warn
    }
  })
})
