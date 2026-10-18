import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { parseCsv, parseWorkbook, type Workbook } from "@sixb/core/artifacts"
import { sheetModel } from "../src/artifacts/renderers/sheet/model"
import { workbookXlsx } from "../src/artifacts/renderers/sheet/xlsx"

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

const unzip = Bun.which("unzip")
let directory = ""
let file = ""

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "sixb-xlsx-"))
  file = join(directory, "workbook.xlsx")
  await writeFile(file, await workbookXlsx([summary, plan]))
})
afterAll(async () => {
  await rm(directory, { recursive: true, force: true })
})

/** Runs unzip with a bound, as a child process: its output, or why it failed. */
async function run(...args: string[]): Promise<string> {
  const child = Bun.spawn([unzip ?? "unzip", ...args], { stdout: "pipe", stderr: "pipe" })
  const timer = setTimeout(() => child.kill(), 10_000)
  const [out, err, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  clearTimeout(timer)
  if (code !== 0) throw new Error(`unzip ${args.join(" ")} exited ${code}: ${err || out}`)
  return out
}

describe.skipIf(!unzip)("a workbook as .xlsx", () => {
  test("is an archive whose every entry is intact", async () => {
    const report = await run("-t", file)
    expect(report).toContain("No errors detected")
    // Bun has CompressionStream, as browsers do: the parts are deflated, not stored.
    expect(await run("-v", file)).toContain("Defl:N")
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
    const book = await run("-p", file, "xl/workbook.xml")
    expect(book).toContain('<sheet name="Summary" sheetId="1" r:id="rId1"/>')
    expect(book).toContain(
      '<sheet name="Q3  plan  draft  with a name lo" sheetId="2" r:id="rId2"/>'
    )
  })

  test("types each column's values in its format, and keeps what is no value as text", async () => {
    const sheet = await run("-p", file, "xl/worksheets/sheet1.xml")
    const styles = await run("-p", file, "xl/styles.xml")
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
    const sheet = await run("-p", file, "xl/worksheets/sheet1.xml")
    expect(sheet).toContain('<c r="A1" s="1" t="inlineStr">')
    expect(sheet).toContain(
      '<pane xSplit="1" ySplit="1" topLeftCell="B2" activePane="bottomRight" state="frozen"/>'
    )
    // 145 pixels is 20 characters of Excel's default font.
    expect(sheet).toContain('<col min="1" max="1" width="20" customWidth="1"/>')
    expect(await run("-p", file, "xl/worksheets/sheet2.xml")).not.toContain("<pane")
  })

  test("links web addresses, and leaves artifact addresses as text", async () => {
    const sheet = await run("-p", file, "xl/worksheets/sheet1.xml")
    const links = await run("-p", file, "xl/worksheets/_rels/sheet1.xml.rels")
    expect(sheet).toContain('<hyperlinks><hyperlink ref="E2" r:id="rId1"/></hyperlinks>')
    expect(links).toContain(
      'Target="https://northline.example/q4?a=1&amp;b=2" TargetMode="External"'
    )
    expect(sheet).toContain("artifact:art_k3m9q2x7tp")
    expect(links).not.toContain("artifact:")
  })
})
