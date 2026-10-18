import { describe, expect, test } from "bun:test"
import type { ArtifactFile } from "../src"
import { ArtifactRequestError, SixbHost } from "../src"
import { formatCsv, parseCsv } from "../src/artifacts/csv"
import {
  checkFormula,
  columnFormulaType,
  evaluateComputedColumns,
  FormulaCycleError,
  formulaDependencies,
  parseFormula,
} from "../src/artifacts/formula"
import type { SheetColumnFormat } from "../src/artifacts/workbook"
import { emptyGrantIndex } from "../src/authorization/types"
import { createTestSixb } from "../src/testing"
import { createTestRuntimeDeps } from "./test-runtime-deps"

const COLUMNS: Record<string, SheetColumnFormat> = {
  Revenue: { type: "currency" },
  Cost: { type: "currency" },
  Qty: { type: "number" },
  Blank: { type: "number" },
  Opened: { type: "date" },
  Closed: { type: "date" },
  Audited: { type: "boolean" },
}
const TABLE = parseCsv(
  [
    "Name,Revenue,Cost,Qty,Blank,Opened,Closed,Audited,Out",
    "Lisbon,1400,910,4,,2026-03-15,2026-09-30,true,",
    'North "B",0,30,2,,2025-12-31,2026-01-02,false,',
    "Kyoto,600,450,,,2026-07-01,,,",
  ].join("\n")
)

/** A formula computed into column Out, typed `type`, in each of the table's three rows. */
function compute(formula: string, type: SheetColumnFormat["type"] = "text"): string[] {
  const { table } = evaluateComputedColumns(
    { columns: { ...COLUMNS, Out: { type, formula } } },
    TABLE
  )
  return table.rows.map((row) => row[8] ?? "")
}

describe("formulas", () => {
  test.each([
    // Precedence, as Excel reads it: a sign binds tighter than ^, ^ tighter than * and /, and
    // each reads left to right, ^ too.
    ["1+2*3", "number", ["7", "7", "7"]],
    ["(1+2)*3", "number", ["9", "9", "9"]],
    ["-2^2", "number", ["4", "4", "4"]],
    ["2^3^2", "number", ["64", "64", "64"]],
    ["10/4", "number", ["2.5", "2.5", "2.5"]],
    // Row references, and a name in brackets.
    ["([@Revenue]-[@Cost])/[@Revenue]", "percent", ["0.35", "#DIV/0!", "0.25"]],
    ["[@[Revenue]]*2", "number", ["2800", "0", "1200"]],
    // A blank reads as 0 in arithmetic and as empty text, as in Excel.
    ["[@Qty]*10", "number", ["40", "20", "0"]],
    ['[@Name]&"/"&[@Blank]', "text", ["Lisbon/", 'North "B"/', "Kyoto/"]],
    ["ISBLANK([@Qty])", "boolean", ["false", "false", "true"]],
    // Whole columns inside aggregates, the same in every row.
    ["[@Revenue]/SUM([Revenue])", "percent", ["0.7", "0", "0.3"]],
    ["AVERAGE([Qty])", "number", ["3", "3", "3"]],
    ["COUNT([Qty])", "number", ["2", "2", "2"]],
    ["MAX([Cost])-MIN([Cost])", "number", ["880", "880", "880"]],
    ["AVERAGE([Blank])", "number", ["#DIV/0!", "#DIV/0!", "#DIV/0!"]],
    // Conditions and logic. AND and OR pass over a blank cell, and NOT reads one as FALSE.
    ['IF([@Revenue]>=1000,"Large","Small")', "text", ["Large", "Small", "Small"]],
    ["IF([@Audited],1,0)", "number", ["1", "0", "0"]],
    ["IF([@Qty]>3,1)", "text", ["1", "FALSE", "FALSE"]],
    ["AND([@Revenue]>0,[@Audited])", "boolean", ["true", "false", "true"]],
    ["OR([@Qty]>3,NOT([@Audited]))", "boolean", ["true", "true", "true"]],
    ["IFERROR([@Cost]/[@Revenue],0)", "number", ["0.65", "0", "0.75"]],
    // Text compares without case; numbers sort before text.
    ['[@Name]="lisbon"', "boolean", ["true", "false", "false"]],
    ['UPPER([@Name])&" "&LEN([@Name])', "text", ["LISBON 6", 'NORTH "B" 9', "KYOTO 5"]],
    ['CONCAT(LOWER([@Name]),"-",[@Qty])', "text", ["lisbon-4", 'north "b"-2', "kyoto-"]],
    // Rounding is half away from zero.
    ["ROUND(2.675,2)", "number", ["2.68", "2.68", "2.68"]],
    ["ROUND(-2.5,0)", "number", ["-3", "-3", "-3"]],
    ["ABS([@Cost]-[@Revenue])", "number", ["490", "30", "150"]],
    // Dates are day counts: a date and days make a date, two dates the days between them.
    ["DAYS([@Closed],[@Opened])", "number", ["199", "2", "-46204"]],
    ["[@Opened]+30", "date", ["2026-04-14", "2026-01-30", "2026-07-31"]],
    ["YEAR([@Opened])*100+MONTH([@Opened])", "number", ["202603", "202512", "202607"]],
  ] as const)("%s computes as Excel does", (formula, type, values) => {
    expect(compute(formula, type)).toEqual([...values])
  })

  test("refuses what does not parse, saying where", () => {
    for (const [formula, message] of [
      ["[@Revenue", "never closed with ']' at character 1"],
      ["1+", "ends where a value is expected"],
      ["1 2", "goes on after a complete value at character 3"],
      ["Revenue*2", "'REVENUE' is not a function call or a reference"],
      ['"open', "never closed at character 1"],
      ["SUM(1;2)", "';' is not part of a formula at character 6"],
    ] as const) {
      expect(() => parseFormula(formula)).toThrow(message)
    }
  })

  test("checks names, whole columns, arguments, and kinds before computing", () => {
    const types = new Map(
      Object.entries({ ...COLUMNS, Name: { type: "text" as const } }).map(([name, format]) => [
        name,
        columnFormulaType(format.type),
      ])
    )
    const check = (formula: string) => checkFormula(parseFormula(formula), types)
    expect(check("[@Revenue]-[@Cost]")).toEqual({ type: "number" })
    expect(check("[@Opened]+7")).toEqual({ type: "date" })
    expect(check("[@Closed]-[@Opened]")).toEqual({ type: "number" })
    expect(check('IF([@Audited],"Yes",1)')).toEqual({ type: "any" })
    expect(check("[@Margin]")).toEqual({
      error: "it reads column 'Margin', which the sheet does not have",
    })
    // Reproduce by letting a whole column stand alone: it computes to #VALUE! in every row.
    expect(check("[Revenue]*2")).toEqual({
      error:
        "[Revenue] is the whole column, which only SUM, AVERAGE, MIN, MAX, COUNT take; this row's value is [@Revenue]",
    })
    expect(check("[@Name]*2")).toEqual({ error: "'*' needs numbers on both sides, not text" })
    expect(check("TODAY()")).toEqual({
      error: expect.stringContaining("TODAY is not a function a sheet computes"),
    })
    expect(check("ROUND([@Revenue])")).toEqual({ error: "ROUND takes 2 arguments, not 1" })
    expect([...formulaDependencies(parseFormula("[@A]+SUM([B])*[@[C d]]"))]).toEqual([
      "A",
      "B",
      "C d",
    ])
  })

  test("computes columns that read each other in order, and refuses a ring", () => {
    const table = parseCsv("Revenue,Cost,Profit,Margin\n100,60,,\n")
    const ordered = evaluateComputedColumns(
      {
        columns: {
          Revenue: { type: "number" },
          Cost: { type: "number" },
          // Margin reads Profit, listed after it.
          Margin: { type: "percent", formula: "[@Profit]/[@Revenue]" },
          Profit: { type: "number", formula: "[@Revenue]-[@Cost]" },
        },
      },
      table
    )
    expect(ordered.table.rows).toEqual([["100", "60", "40", "0.4"]])
    expect(() =>
      evaluateComputedColumns(
        {
          columns: {
            Profit: { type: "number", formula: "[@Margin]*2" },
            Margin: { type: "number", formula: "[@Profit]/2" },
          },
        },
        table
      )
    ).toThrow(FormulaCycleError)
  })

  test("writes CSV that reads back as it was", () => {
    const rows = [
      ["Lisbon", "1,400", 'Says "hi"', "two\nlines"],
      ["", "", "", ""],
    ]
    const text = formatCsv(["Name", "Revenue", "Note", "Address"], rows)
    expect(text.startsWith("Name,Revenue,Note,Address\r\n")).toBe(true)
    expect(parseCsv(text)).toEqual({ header: ["Name", "Revenue", "Note", "Address"], rows })
  })
})

describe("publishing computed columns", () => {
  function setup() {
    const deps = createTestRuntimeDeps()
    const host = new SixbHost({ id: "formulas", ontology: [], ...deps })
    const sixb = createTestSixb(host, {
      authorization: {
        principal: { type: "user", id: "alice" },
        groupIds: [],
        roleIds: [],
        grants: emptyGrantIndex(),
      },
    })
    return async (columns: Record<string, unknown>, csv: string) => {
      const files: ArtifactFile[] = []
      for (const [path, body] of Object.entries({
        "workbook.json": JSON.stringify({ sheets: [{ name: "Hotels", columns }] }),
        "sheets/Hotels.csv": csv,
      })) {
        files.push({
          path,
          file: await deps.blobStorage.put({
            body: new TextEncoder().encode(body),
            fileName: path.split("/").at(-1) ?? path,
          }),
        })
      }
      return sixb.artifacts.create({ kind: "sheet", title: "Hotels", files })
    }
  }
  const refusal = async (promise: Promise<unknown>) => {
    const error = await promise.then(
      () => null,
      (caught: unknown) => caught
    )
    expect(error).toBeInstanceOf(ArtifactRequestError)
    return (error as Error).message
  }
  const MARGIN = { type: "percent", formula: "=([@Revenue]-[@Cost])/[@Revenue]" }

  test("warns of rows that compute to an error, and keeps the version", async () => {
    const publish = setup()
    const published = await publish(
      { Revenue: "currency", Cost: "currency", Margin: MARGIN },
      "Hotel,Revenue,Cost,Margin\nLisbon,1400,910,\nKyoto,0,450,\nBanff,,10,\n"
    )
    expect(published.version.outline).toMatchObject({
      sheets: [{ name: "Hotels", columns: ["Hotel", "Revenue", "Cost", "Margin"] }],
    })
    expect(published.warnings).toEqual([
      {
        code: "sheet_formula_error",
        part: "Hotels",
        message:
          "Sheet 'Hotels' column 'Margin' computes to #DIV/0! in 2 rows, the first row 3. IFERROR gives those rows a value.",
      },
    ])
  })

  test("refuses values in a computed column, a formula that can't compute, and a ring", async () => {
    const publish = setup()
    const header = "Hotel,Revenue,Cost,Margin\n"
    expect(
      await refusal(
        publish(
          { Revenue: "currency", Cost: "currency", Margin: MARGIN },
          `${header}Lisbon,1400,910,0.35\n`
        )
      )
    ).toContain(`row 2, column 'Margin': "0.35" is in a computed column; leave its values empty`)
    expect(
      await refusal(
        publish(
          {
            Revenue: "currency",
            Cost: "currency",
            Margin: { type: "percent", formula: "[@Revnue]/2" },
          },
          `${header}Lisbon,1400,910,\n`
        )
      )
    ).toContain(
      "column 'Margin' \"formula\": it reads column 'Revnue', which the sheet does not have."
    )
    expect(
      await refusal(
        publish(
          { Revenue: "currency", Margin: { type: "date", formula: "[@Revenue]*2" } },
          `${header}Lisbon,1400,910,\n`
        )
      )
    ).toContain("computes a number, which a date column can't show")
    expect(
      await refusal(
        publish(
          {
            Revenue: { type: "number", formula: "[@Margin]+1" },
            Margin: { type: "number", formula: "[@Revenue]*2" },
          },
          `${header}Lisbon,,910,\n`
        )
      )
    ).toContain("columns 'Revenue' → 'Margin' → 'Revenue' compute from each other")
    expect(
      await refusal(publish({ Margin: { type: "number", formula: "1+" } }, `${header}Lisbon,,,\n`))
    ).toContain(
      "column 'Margin' \"formula\" does not read: The formula ends where a value is expected"
    )
  })
})
