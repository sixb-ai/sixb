import { describe, expect, test } from "bun:test"
import type { ArtifactFile, ArtifactRequestErrorCode, FileRef } from "../src"
import { ArtifactRequestError, SixbHost } from "../src"
import { createArtifactId } from "../src/artifacts/ids"
import { createHeadingSlugger } from "../src/artifacts/outline"
import { parseArtifactTheme } from "../src/artifacts/theme"
import { emptyGrantIndex } from "../src/authorization/types"
import { createTestSixb } from "../src/testing"
import { createTestRuntimeDeps } from "./test-runtime-deps"

function setup() {
  const deps = createTestRuntimeDeps()
  const host = new SixbHost({ id: "artifacts", ontology: [], ...deps })
  const as = (id: string) =>
    createTestSixb(host, {
      authorization: {
        principal: { type: "user", id },
        groupIds: [],
        roleIds: [],
        grants: emptyGrantIndex(),
      },
    })
  const put = async (path: string, body: string, mediaType?: string): Promise<ArtifactFile> => ({
    path,
    file: await deps.blobStorage.put({
      body: new TextEncoder().encode(body),
      fileName: path.split("/").at(-1) ?? path,
      ...(mediaType ? { mediaType } : {}),
    }),
  })
  return { host, deps, as, put }
}

async function expectRequestError(
  promise: Promise<unknown>,
  code: ArtifactRequestErrorCode,
  message?: string
) {
  const error = await promise.then(
    () => null,
    (caught: unknown) => caught
  )
  expect(error).toBeInstanceOf(ArtifactRequestError)
  expect((error as ArtifactRequestError).code).toBe(code)
  if (message) expect((error as Error).message).toContain(message)
}

const REPORT = [
  "# Q3 report",
  "",
  "Revenue grew 18% on enterprise renewals.",
  "",
  "## Revenue &amp; cost",
  "",
  '![Revenue](figures/revenue%20chart.svg "Figure 1")',
  "",
  "## Revenue & *cost*",
  "",
  "### Methodology",
].join("\n")

describe("publishing a document", () => {
  test("reads its headings into section slugs and keeps its files", async () => {
    const { as, put } = setup()
    const files = [
      await put("document.md", REPORT, "text/markdown"),
      await put("figures/revenue chart.svg", "<svg/>", "image/svg+xml"),
    ]

    const published = await as("alice").artifacts.create({
      kind: "document",
      title: " Q3 report ",
      files,
    })

    expect(published.artifact).toMatchObject({
      // Short, from an alphabet without easily misread letters.
      id: expect.stringMatching(/^art_[0-9abcdefghjkmnpqrstvwxyz]{10}$/),
      kind: "document",
      title: "Q3 report",
      owner: { type: "user", id: "alice" },
      latestVersion: 1,
    })
    expect(published.version).toMatchObject({
      version: 1,
      entry: "document.md",
      files,
      references: [],
      author: { type: "user", id: "alice" },
    })
    expect(published.version).not.toHaveProperty("origin")
    expect(published.version.outline).toEqual({
      kind: "document",
      headings: [
        { depth: 1, text: "Q3 report", slug: "q3-report" },
        { depth: 2, text: "Revenue & cost", slug: "revenue-cost" },
        { depth: 2, text: "Revenue & cost", slug: "revenue-cost-1" },
        { depth: 3, text: "Methodology", slug: "methodology" },
      ],
    })
    expect(published.warnings).toEqual([])
  })

  test("refuses images that are not files in the artifact", async () => {
    const { as, put } = setup()
    const create = async (markdown: string) =>
      as("alice").artifacts.create({
        kind: "document",
        title: "Report",
        files: [await put("document.md", markdown)],
      })

    await expectRequestError(
      create("![x](figures/missing.png)"),
      "invalid_artifact",
      "not one of the artifact's files"
    )
    await expectRequestError(
      create("![x](https://example.com/a.png)"),
      "invalid_artifact",
      "Images must be files in the artifact"
    )
    await expectRequestError(
      create("![x](data:image/png;base64,AAAA)"),
      "invalid_artifact",
      "Images must be files"
    )
    await expectRequestError(
      create("![x](artifact:art_other#chart=revenue)"),
      "invalid_artifact",
      "is not an artifact address"
    )
    await expectRequestError(
      create("![x](../outside.png)"),
      "invalid_artifact",
      "not one of the artifact's files"
    )
  })

  test("checks a theme.json it carries", async () => {
    const { as, put } = setup()
    const create = async (theme: string) =>
      as("alice").artifacts.create({
        kind: "document",
        title: "Report",
        files: [await put("document.md", "# Report"), await put("theme.json", theme)],
      })

    await expectRequestError(
      create('{"tokens":{"--primary":"url(x)"}}'),
      "invalid_artifact",
      "--primary"
    )
    await expectRequestError(create('{"mode":"sepia"}'), "invalid_artifact", '"mode"')
    expect(
      (await create('{"mode":"dark","tokens":{"--primary":"#c2410c"}}')).version.files
    ).toHaveLength(2)
  })
})

describe("publishing any version", () => {
  test("refuses unsafe paths, repeated paths, unstored files, an empty title, and an unknown kind", async () => {
    const { as, put } = setup()
    const doc = await put("document.md", "# Report")
    const create = (files: ArtifactFile[], title = "Report") =>
      as("alice").artifacts.create({ kind: "document", title, files })

    await expectRequestError(
      create([doc, { ...doc, path: "../escape.md" }]),
      "invalid_artifact",
      "not a usable file path"
    )
    await expectRequestError(
      create([doc, { ...doc, path: "/abs.md" }]),
      "invalid_artifact",
      "not a usable file path"
    )
    await expectRequestError(create([doc, doc]), "invalid_artifact", "appears twice")
    await expectRequestError(create([doc], "   "), "invalid_artifact", "title")
    await expectRequestError(create([]), "invalid_artifact", "at least one file")
    const notStored: FileRef = { ...doc.file, sizeBytes: doc.file.sizeBytes + 1 }
    await expectRequestError(
      create([{ path: "document.md", file: notStored }]),
      "invalid_artifact",
      "not stored"
    )
    await expectRequestError(
      as("alice").artifacts.create({ kind: "canvas" as never, title: "Q3", files: [doc] }),
      "invalid_artifact",
      "'canvas' is not a kind of artifact"
    )
  })

  test("publishes a file as it is, and only one", async () => {
    const { as, put } = setup()
    const deck = await put("board-pack.pdf", "%PDF-1.7", "application/pdf")

    const published = await as("alice").artifacts.create({
      kind: "file",
      title: "Board pack",
      files: [deck],
    })
    expect(published.version).toMatchObject({
      entry: "board-pack.pdf",
      outline: { kind: "file", mediaType: "application/pdf" },
    })

    await expectRequestError(
      as("alice").artifacts.create({
        kind: "file",
        title: "Two",
        files: [deck, { ...deck, path: "copy.pdf" }],
      }),
      "invalid_artifact",
      "exactly one file"
    )
  })
})

describe("artifact ownership", () => {
  test("only the owner and system code read; only the owner publishes and deletes; the kind never changes", async () => {
    const { host, as, put } = setup()
    const files = [await put("document.md", "# Report")]
    const { artifact } = await as("alice").artifacts.create({
      kind: "document",
      title: "Report",
      files,
    })

    expect(await as("bob").artifacts.get(artifact.id)).toBeNull()
    expect(await as("bob").artifacts.getVersion(artifact.id, "latest")).toBeNull()
    expect(await as("bob").artifacts.listVersions(artifact.id)).toBeNull()
    expect((await as("bob").artifacts.list()).total).toBe(0)
    await expectRequestError(
      as("bob").artifacts.publish(artifact.id, { kind: "document", title: "Mine now", files }),
      "artifact_not_found"
    )
    expect(await as("bob").artifacts.delete(artifact.id)).toBe(false)
    expect((await createTestSixb(host).artifacts.get(artifact.id))?.id).toBe(artifact.id)

    const second = await as("alice").artifacts.publish(artifact.id, {
      kind: "document",
      title: "Report, revised",
      files,
    })
    expect(second.version.version).toBe(2)
    expect((await as("alice").artifacts.getVersion(artifact.id, "latest"))?.title).toBe(
      "Report, revised"
    )
    await expectRequestError(
      as("alice").artifacts.publish(artifact.id, { kind: "file", title: "Report", files }),
      "artifact_kind_mismatch"
    )
    expect((await as("alice").artifacts.list()).artifacts.map((item) => item.id)).toEqual([
      artifact.id,
    ])
    expect(await as("alice").artifacts.delete(artifact.id)).toBe(true)
    expect(await as("alice").artifacts.get(artifact.id)).toBeNull()
  })
})

describe("artifact model helpers", () => {
  test("slugs headings the way the renderer names sections", () => {
    const slug = createHeadingSlugger()
    expect(["Revenue", "Revenue", "Revenue 1", "Café & crème", "   ", "!!"].map(slug)).toEqual([
      "revenue",
      "revenue-1",
      "revenue-1-1",
      "café-crème",
      "section",
      "section-1",
    ])
  })

  test("reads a theme and refuses values that could escape a CSS property", () => {
    expect(
      parseArtifactTheme(
        JSON.stringify({
          mode: "light",
          tokens: {
            "--primary": "oklch(0.62 0.1 210)",
            "--chart-1": "#2F7280",
            "--font-sans": '"Inter Tight", system-ui, sans-serif',
            "--radius": "0.4rem",
          },
        })
      )
    ).toEqual({
      theme: {
        mode: "light",
        tokens: {
          "--primary": "oklch(0.62 0.1 210)",
          "--chart-1": "#2F7280",
          "--font-sans": '"Inter Tight", system-ui, sans-serif',
          "--radius": "0.4rem",
        },
      },
    })
    for (const value of [
      "red; } body { display: none",
      "url(https://example.com/x)",
      "var(--background)",
      "rgb(0 0 0) !important",
    ]) {
      expect(
        parseArtifactTheme(JSON.stringify({ tokens: { "--primary": value } })),
        value
      ).toHaveProperty("error")
    }
    expect(parseArtifactTheme(JSON.stringify({ tokens: { "--font-sans": "a;b" } }))).toHaveProperty(
      "error"
    )
    expect(parseArtifactTheme(JSON.stringify({ tokens: { "--sidebar": "#fff" } }))).toHaveProperty(
      "error"
    )
    expect(parseArtifactTheme("{")).toEqual({ error: "theme.json is not valid JSON." })
  })

  test("makes short ids from an alphabet without easily misread letters", () => {
    // One id misses re-added i, l, o and u about a third of the time; 200 never do.
    const ids = new Set(Array.from({ length: 200 }, createArtifactId))
    expect(ids.size).toBe(200)
    for (const id of ids) expect(id).toMatch(/^art_[0-9abcdefghjkmnpqrstvwxyz]{10}$/)
  })
})
