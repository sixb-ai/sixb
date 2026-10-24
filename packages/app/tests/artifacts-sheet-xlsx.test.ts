import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { parseCsv, parseFormula, parseWorkbook, type Workbook } from "@sixb/core/artifacts"
import { sheetModel } from "../src/artifacts/renderers/sheet/model"
import { formulaToA1, workbookXlsx } from "../src/artifacts/renderers/sheet/xlsx"
import { UNZIP, unzip } from "./helpers/unzip"

const workbook = (() => {
  const parsed = parseWorkbook(
    JSON.stringify({
      sheets: [
        {
          name: "Summary",
          frozenColumns: 1,
          columns: {
            Revenue: "currency",
            Margin: { type: "percent", decimals: 1 },
            Closed: "date",
            Site: "link",
          },
          widths: { Quarter: 145 },
        },
        { name: "Q3: plan [draft] with a name longer than Excel takes?", frozenRows: 0 },
        {
          name: "Regions",
          columns: {
            Visits: { type: "number", compact: true, highlight: "bars" },
            Change: { type: "percent", decimals: 1, signed: true, highlight: "diverging" },
            Audited: "boolean",
          },
          totals: { Visits: "sum", Change: "average" },
        },
        {
          name: "Margins",
          columns: {
            Revenue: "currency",
            Cost: "currency",
            Margin: { type: "percent", formula: "([@Revenue]-[@Cost])/[@Revenue]" },
            Share: { type: "percent", formula: "[@Revenue]/SUM([Revenue])" },
            Label: {
              type: "text",
              formula: 'CONCAT([@Hotel]," ",IF([@Revenue]>1000,"large","small"))',
            },
          },
        },
      ],
    })
  )
  if (!("workbook" in parsed)) throw new Error(parsed.error)
  return parsed.workbook as Workbook
})()

const summary = sheetModel(
  workbook.sheets[0] as Workbook["sheets"][number],
  parseCsv(
    [
      "Quarter,Revenue,Margin,Closed,Site",
      "Q4 2025,4120000,0.269,2025-12-31,https://northline.example/q4?a=1&b=2",
      'Q1 2026,"n/a",0.281,2026-03-31,artifact:art_k3m9q2x7tp',
      "Q2 <draft> & more,,0.3,,",
    ].join("\n")
  )
)
const plan = sheetModel(
  workbook.sheets[1] as Workbook["sheets"][number],
  parseCsv("Item,Count\nPumps,3\n")
)

const regions = sheetModel(
  workbook.sheets[2] as Workbook["sheets"][number],
  parseCsv("Region,Visits,Change,Audited\nNorth,1284000,0.04,true\nSouth,962000,-0.01,FALSE\n")
)

const margins = sheetModel(
  workbook.sheets[3] as Workbook["sheets"][number],
  parseCsv(
    "Hotel,Revenue,Cost,Margin,Share,Label\nLisbon,1400,910,,,\nKyoto,600,450,,,\nNew,0,10,,,\n"
  )
)

let directory = ""
let file = ""

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "sixb-xlsx-"))
  file = join(directory, "workbook.xlsx")
  await writeFile(file, await workbookXlsx([summary, plan, regions, margins]))
})
afterAll(async () => {
  await rm(directory, { recursive: true, force: true })
})

describe.skipIf(!UNZIP)("a workbook as .xlsx", () => {
  test("is an archive whose every entry is intact", async () => {
    const report = await unzip("-t", file)
    expect(report).toContain("No errors detected")
    // Bun has CompressionStream, as browsers do: the parts are deflated, not stored.
    expect(await unzip("-v", file)).toContain("Defl:N")
    for (const part of [
      "[Content_Types].xml",
      "_rels/.rels",
      "xl/workbook.xml",
      "xl/_rels/workbook.xml.rels",
      "xl/styles.xml",
      "xl/worksheets/sheet1.xml",
      "xl/worksheets/_rels/sheet1.xml.rels",
      "xl/worksheets/sheet2.xml",
    ]) {
      expect(report).toContain(part)
    }
  })

  test("names its sheets as Excel takes them", async () => {
    const book = await unzip("-p", file, "xl/workbook.xml")
    expect(book).toContain('<sheet name="Summary" sheetId="1" r:id="rId1"/>')
    expect(book).toContain(
      '<sheet name="Q3  plan  draft  with a name lo" sheetId="2" r:id="rId2"/>'
    )
  })

  test("types each column's values in its format, and keeps what is no value as text", async () => {
    const sheet = await unzip("-p", file, "xl/worksheets/sheet1.xml")
    const styles = await unzip("-p", file, "xl/styles.xml")
    expect(styles).toContain('formatCode="&quot;$&quot;#,##0"')
    expect(styles).toContain('formatCode="0.0%"')
    expect(styles).toContain('formatCode="yyyy-mm-dd"')

    expect(sheet).toMatch(/<c r="B2" s="\d+"><v>4120000<\/v><\/c>/)
    expect(sheet).toMatch(/<c r="C2" s="\d+"><v>0.269<\/v><\/c>/)
    // 2025-12-31 is day 46022 counted from Excel's 1899-12-30.
    expect(sheet).toMatch(/<c r="D2" s="\d+"><v>46022<\/v><\/c>/)
    expect(sheet).toContain('<c r="B3" t="inlineStr"><is><t xml:space="preserve">n/a</t></is></c>')
    expect(sheet).toContain("Q2 &lt;draft&gt; &amp; more")
    // Empty cells are left out.
    expect(sheet).not.toContain('r="B4"')
  })

  test("bolds the header, freezes what the sheet froze, and keeps its widths", async () => {
    const sheet = await unzip("-p", file, "xl/worksheets/sheet1.xml")
    expect(sheet).toContain('<c r="A1" s="1" t="inlineStr">')
    expect(sheet).toContain(
      '<pane xSplit="1" ySplit="1" topLeftCell="B2" activePane="bottomRight" state="frozen"/>'
    )
    // 145 pixels is 20 characters of Excel's default font.
    expect(sheet).toContain('<col min="1" max="1" width="20" customWidth="1"/>')
    expect(await unzip("-p", file, "xl/worksheets/sheet2.xml")).not.toContain("<pane")
  })

  test("links web addresses, and leaves artifact addresses as text", async () => {
    const sheet = await unzip("-p", file, "xl/worksheets/sheet1.xml")
    const links = await unzip("-p", file, "xl/worksheets/_rels/sheet1.xml.rels")
    expect(sheet).toContain('<hyperlinks><hyperlink ref="E2" r:id="rId1"/></hyperlinks>')
    expect(links).toContain(
      'Target="https://northline.example/q4?a=1&amp;b=2" TargetMode="External"'
    )
    expect(sheet).toContain("artifact:art_k3m9q2x7tp")
    expect(links).not.toContain("artifact:")
  })

  test("totals with formulas a filter in Excel keeps right, and styles compact and signed", async () => {
    const sheet = await unzip("-p", file, "xl/worksheets/sheet3.xml")
    const styles = await unzip("-p", file, "xl/styles.xml")
    // Under the data, bold: "Total" in the first column without one, then SUBTOTAL formulas
    // with their values. Reproduce with SUM in place of SUBTOTAL(109): Excel's filter
    // would leave the hidden rows in the total.
    expect(sheet).toContain('<row r="4"><c r="A4" s="1" t="inlineStr"><is><t>Total</t></is></c>')
    expect(sheet).toMatch(/<c r="B4" s="\d+"><f>SUBTOTAL\(109,B2:B3\)<\/f><v>2246000<\/v><\/c>/)
    expect(sheet).toMatch(/<c r="C4" s="\d+"><f>SUBTOTAL\(101,C2:C3\)<\/f><v>0\.015\d*<\/v><\/c>/)
    expect(styles).toContain('formatCode="+0.0%;-0.0%;0.0%"')
    expect(styles).toContain(
      'formatCode="[&gt;=1000000]#,##0.0,,&quot;M&quot;;[&gt;=1000]#,##0.0,&quot;K&quot;;#,##0"'
    )
    expect(styles).toMatch(
      /<xf numFmtId="\d+" fontId="1" [^>]*applyNumberFormat="1" applyFont="1"\/>/
    )
    // A sheet without totals has no totals row.
    expect(await unzip("-p", file, "xl/worksheets/sheet1.xml")).not.toContain("SUBTOTAL")
  })

  test("writes checkboxes as booleans and highlights as conditional formats", async () => {
    const sheet = await unzip("-p", file, "xl/worksheets/sheet3.xml")
    expect(sheet).toContain('<c r="D2" t="b"><v>1</v></c>')
    expect(sheet).toContain('<c r="D3" t="b"><v>0</v></c>')
    expect(sheet).toContain(
      '<conditionalFormatting sqref="B2:B3"><cfRule type="dataBar" priority="1">'
    )
    expect(sheet).toContain(
      '<conditionalFormatting sqref="C2:C3"><cfRule type="colorScale" priority="2"><colorScale><cfvo type="min"/><cfvo type="num" val="0"/><cfvo type="max"/>'
    )
    // Excel reads the parts of a worksheet in order: formats after the data, before the links.
    expect(sheet.indexOf("</sheetData>")).toBeLessThan(sheet.indexOf("<conditionalFormatting"))
  })

  test("writes computed cells as A1 formulas, with the values the grid shows", async () => {
    const sheet = await unzip("-p", file, "xl/worksheets/sheet4.xml")
    expect(sheet).toMatch(/<c r="D2" s="\d+"><f>\(B2-C2\)\/B2<\/f><v>0.35<\/v><\/c>/)
    expect(sheet).toContain('<c r="D4" t="e"><f>(B4-C4)/B4</f><v>#DIV/0!</v></c>')
    expect(sheet).toMatch(/<c r="E2" s="\d+"><f>B2\/SUM\(\$B\$2:\$B\$4\)<\/f><v>0.7<\/v><\/c>/)
    // CONCAT is newer than the file format: Excel reads it only with its _xlfn. prefix.
    expect(sheet).toContain(
      '<c r="F2" t="str"><f>_xlfn.CONCAT(A2,&quot; &quot;,IF(B2&gt;1000,&quot;large&quot;,&quot;small&quot;))</f><v>Lisbon large</v></c>'
    )
  })
})

describe("a formula in A1 references", () => {
  test("keeps only the parentheses Excel's precedence needs", () => {
    const letters = new Map([
      ["A", "B"],
      ["B", "C"],
    ])
    const a1 = (formula: string) => formulaToA1(parseFormula(formula), letters, 7, 20)
    expect(a1("[@A]-([@B]-1)")).toBe("B7-(C7-1)")
    expect(a1("([@A]-[@B])-1")).toBe("B7-C7-1")
    expect(a1("([@A]+[@B])*2")).toBe("(B7+C7)*2")
    expect(a1("[@A]+[@B]*2")).toBe("B7+C7*2")
    expect(a1("-([@A]+1)")).toBe("-(B7+1)")
    expect(a1('[@A]&"%"')).toBe('B7&"%"')
    expect(a1("AVERAGE([A])")).toBe("AVERAGE($B$2:$B$20)")
    expect(a1("DAYS([@A],[@B])")).toBe("_xlfn.DAYS(B7,C7)")
  })
})
