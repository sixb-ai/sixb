import { describe, expect, test } from "bun:test"
import type { ArtifactFile } from "../src"
import { ArtifactRequestError, SixbHost } from "../src"
import { CsvParseError, parseCsv } from "../src/artifacts/csv"
import { parseSheetDate, parseSheetNumber, parseWorkbook } from "../src/artifacts/workbook"
import { emptyGrantIndex } from "../src/authorization/types"
import { createTestSixb } from "../src/testing"
import { createTestRuntimeDeps } from "./test-runtime-deps"

describe("parseCsv", () => {
  test("reads quotes, doubled quotes, line breaks in fields, CRLF, CR, and a byte-order mark", () => {
    expect(
      parseCsv(
        '﻿name,,note\r\nAlice,42,"hello, world"\r\nBob,,"line 1\nline 2"\rEve,7,"said ""hi"""\r\n'
      )
    ).toEqual({
      header: ["name", "", "note"],
      rows: [
        ["Alice", "42", "hello, world"],
        ["Bob", "", "line 1\nline 2"],
        ["Eve", "7", 'said "hi"'],
      ],
    })
  })

  test("keeps rows as written, skips blank lines, and reads tabs when asked", () => {
    expect(parseCsv("a,b\n1\n\n2,3,4\n")).toEqual({
      header: ["a", "b"],
      rows: [["1"], ["2", "3", "4"]],
    })
    expect(parseCsv('a\tb\nx\t"y\tz"', { delimiter: "\t" }).rows).toEqual([["x", "y\tz"]])
    expect(parseCsv("")).toEqual({ header: [], rows: [] })
  })

  test("says on which line a record cannot be read", () => {
    for (const [text, message, line] of [
      ['a,b\n"open,1', "never closed", 2],
      ['a,b\n1,2\n"x"y,1', "goes on after its closing quote", 3],
    ] as const) {
      const error = (() => {
        try {
          parseCsv(text)
        } catch (caught) {
          return caught
        }
      })()
      expect(error).toBeInstanceOf(CsvParseError)
      expect((error as CsvParseError).message).toContain(message)
      expect((error as CsvParseError).line).toBe(line)
    }
  })
})

describe("parseWorkbook", () => {
  test("fills the full form from its shorthand", () => {
    const parsed = parseWorkbook(
      JSON.stringify({
        sheets: [
          {
            name: "Summary",
            columns: { Revenue: "currency", Margin: { type: "percent", decimals: 1 } },
            widths: { Quarter: 120 },
          },
        ],
        charts: [{ name: "revenue", type: "bar", sheet: "Summary", x: "Quarter", y: "Revenue" }],
      })
    )
    expect(parsed).toEqual({
      workbook: {
        sheets: [
          {
            name: "Summary",
            frozenRows: 1,
            frozenColumns: 0,
            columns: { Revenue: { type: "currency" }, Margin: { type: "percent", decimals: 1 } },
            widths: { Quarter: 120 },
          },
        ],
        charts: [
          {
            name: "revenue",
            type: "bar",
            sheet: "Summary",
            x: "Quarter",
            y: ["Revenue"],
            stacked: false,
          },
        ],
      },
    })
  })

  test.each([
    ["{", "is not valid JSON"],
    [{ sheets: [] }, '"sheets" must list at least one sheet'],
    [{ sheets: [{ name: "a/b" }] }, "without / or \\"],
    [{ sheets: [{ name: "A" }, { name: "a" }] }, "two sheets are named 'a'"],
    [{ sheets: [{ name: "A", columns: { X: "money" } }] }, 'type "money"; use one of text, number'],
    [
      { sheets: [{ name: "A", columns: { X: { type: "number", currency: "USD" } } }] },
      "is not a currency column",
    ],
    [
      {
        sheets: [{ name: "A" }],
        charts: [{ name: "Revenue", type: "bar", sheet: "A", x: "x", y: "y" }],
      },
      "lowercase letters",
    ],
    [
      { sheets: [{ name: "A" }], charts: [{ name: "r", type: "bar", sheet: "B", x: "x", y: "y" }] },
      "does not have",
    ],
    [
      {
        sheets: [{ name: "A" }],
        charts: [{ name: "r", type: "pie", sheet: "A", x: "x", y: ["y", "z"] }],
      },
      "give it one",
    ],
    [
      {
        sheets: [{ name: "A" }],
        charts: [{ name: "r", type: "line", sheet: "A", x: "x", y: "y", stacked: true }],
      },
      "only bar and area charts stack",
    ],
    [
      {
        sheets: [{ name: "A" }],
        charts: [{ name: "r", type: "bar", sheet: "A", x: "x", y: ["a", "b", "c", "d", "e", "f"] }],
      },
      "at most 5",
    ],
  ])("refuses %j: %s", (input, message) => {
    const parsed = parseWorkbook(typeof input === "string" ? input : JSON.stringify(input))
    expect("error" in parsed && parsed.error).toContain(message)
  })

  test("reads numbers and dates the way a sheet stores them", () => {
    expect(["4120000", "-3.5", "+.5", "1e3"].map(parseSheetNumber)).toEqual([
      4120000, -3.5, 0.5, 1000,
    ])
    expect(["$4.1M", "1,234", "12%", "", "NaN"].map(parseSheetNumber)).toEqual([
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
    ])
    expect(parseSheetDate("2026-10-17")?.toISOString()).toBe("2026-10-17T00:00:00.000Z")
    expect(parseSheetDate("2026-10-17T14:05:00Z")?.toISOString()).toBe("2026-10-17T14:05:00.000Z")
    expect(parseSheetDate("10/17/2026")).toBeUndefined()
    expect(parseSheetDate("2026-13-40")).toBeUndefined()
  })
})

const WORKBOOK = {
  sheets: [
    { name: "Summary", columns: { Revenue: "currency", Margin: "percent", Quarter: "text" } },
    { name: "Accounts", frozenColumns: 1, columns: { Logo: "image", Site: "link", Since: "date" } },
  ],
  charts: [{ name: "revenue", type: "bar", sheet: "Summary", x: "Quarter", y: ["Revenue"] }],
}
const SUMMARY = "Quarter,Revenue,Margin\nQ2 2026,4710000,0.301\nQ3 2026,5560000,0.351\n"
const ACCOUNTS =
  "Name,Logo,Site,Since\nHarbor Point,images/harbor.png,https://harbor.example,2019-04-01\nCentral,,,\n"

function setup() {
  const deps = createTestRuntimeDeps()
  const host = new SixbHost({ id: "sheets", ontology: [], ...deps })
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
    file: await deps.blobStorage.put({
      body: new TextEncoder().encode(body),
      fileName: path.split("/").at(-1) ?? path,
    }),
  })
  const publish = async (overrides: Record<string, string | null> = {}) => {
    const contents: Record<string, string | null> = {
      "workbook.json": JSON.stringify(WORKBOOK),
      "sheets/Summary.csv": SUMMARY,
      "sheets/Accounts.csv": ACCOUNTS,
      "images/harbor.png": "png",
      ...overrides,
    }
    const files: ArtifactFile[] = []
    for (const [path, body] of Object.entries(contents)) {
      if (body !== null) files.push(await put(path, body))
    }
    return sixb.artifacts.create({ kind: "sheet", title: "Q3 numbers", files })
  }
  return { publish }
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

describe("publishing a sheet", () => {
  test("outlines its sheets and charts", async () => {
    const { publish } = setup()
    const published = await publish()
    expect(published.version.entry).toBe("workbook.json")
    expect(published.version.outline).toEqual({
      kind: "sheet",
      sheets: [
        { name: "Summary", rows: 2, columns: ["Quarter", "Revenue", "Margin"] },
        { name: "Accounts", rows: 2, columns: ["Name", "Logo", "Site", "Since"] },
      ],
      charts: ["revenue"],
    })
  })

  test("says what to fix in the files", async () => {
    const { publish } = setup()
    const cases: [Record<string, string | null>, string][] = [
      [{ "workbook.json": null }, "A sheet is a directory: 'workbook.json' listing its sheets"],
      [
        { "sheets/Accounts.csv": null },
        "Sheet 'Accounts' needs its values in 'sheets/Accounts.csv'",
      ],
      [{ "sheets/Extra.csv": "a\n1\n" }, "'sheets/Extra.csv' is not a sheet in workbook.json"],
      [{ "sheets/Summary.csv": "" }, "'sheets/Summary.csv' is empty"],
      [{ "sheets/Summary.csv": "Quarter,,Margin\n" }, "column 2 has no name"],
      [{ "sheets/Summary.csv": 'Quarter,Revenue,Margin\n"Q3' }, "never closed"],
      [{ "sheets/Summary.csv": "Quarter,Revenue,Margin\nQ3,1,0.1,extra\n" }, "row 2 has 4 fields"],
      [
        { "sheets/Summary.csv": "Quarter,Revenue,Margin\nQ3,$5.56M,0.351\n" },
        `'sheets/Summary.csv' row 2, column 'Revenue': "$5.56M" is not a number`,
      ],
      [
        { "sheets/Summary.csv": "Quarter,Revenue,Margin\nQ3,5560000,35.1%\n" },
        "write a percent as a fraction",
      ],
      [
        { "sheets/Accounts.csv": "Name,Logo,Site,Since\nX,images/missing.png,,\n" },
        "is not one of the artifact's files",
      ],
      [{ "sheets/Accounts.csv": "Name,Logo,Site,Since\nX,,ftp://x,\n" }, "full https:// address"],
      [{ "sheets/Accounts.csv": "Name,Logo,Site,Since\nX,,,04/01/2019\n" }, "write YYYY-MM-DD"],
      [
        {
          "workbook.json": JSON.stringify({
            ...WORKBOOK,
            charts: [{ name: "r", type: "bar", sheet: "Summary", x: "Quarter", y: ["Cost"] }],
          }),
        },
        "plots column 'Cost', which sheet 'Summary' does not have",
      ],
      [
        {
          "workbook.json": JSON.stringify({
            ...WORKBOOK,
            charts: [{ name: "r", type: "bar", sheet: "Summary", x: "Revenue", y: ["Quarter"] }],
          }),
        },
        "plots column 'Quarter', which is text",
      ],
      [
        {
          "workbook.json": JSON.stringify({
            ...WORKBOOK,
            charts: [{ name: "r", type: "pie", sheet: "Summary", x: "Quarter", y: "Revenue" }],
          }),
          "sheets/Summary.csv": `Quarter,Revenue,Margin\n${Array.from({ length: 6 }, (_, i) => `Q${i},1,0.1`).join("\n")}\n`,
        },
        "a pie with 6 slices",
      ],
    ]
    for (const [overrides, message] of cases) {
      expect(await refusal(publish(overrides))).toContain(message)
    }
  })
})
