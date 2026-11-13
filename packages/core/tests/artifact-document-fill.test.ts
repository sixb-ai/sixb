import { describe, expect, test } from "bun:test"
import { fillDocumentHtml } from "../src/artifacts/document-fill"

// A designed document's markup with a reader's values written in, as a frozen or printed version
// keeps it, on the server.

const html = (body: string) =>
  `<!doctype html><html lang="en"><head></head><body>${body}</body></html>`
const holder = { primaryId: "c1", properties: { amount: 1.2345, note: "", title: "Repair" } }

describe("a designed document written in plain", () => {
  // Reproduce by leaving the marks of what was not read in documentData's fill: the frozen version
  // keeps a field that reads `open`, which every reader's frame fills again, and the PDF's
  // sandbox reads as the query's definition.
  test("keeps no field marked, filled or not, nor any repeated element or what it holds", () => {
    const written = fillDocumentHtml(
      html(
        `<h1 data-sixb-field="title">Title</h1>
<p data-sixb-field="query:open.total">3</p>
<ul><li data-sixb-each="query:open"><span data-sixb-field="number">SC-1</span></li></ul>
<p data-sixb-field="amount" data-currency-field="currency">$0</p>`
      ),
      { holder, queries: {} },
      { plain: true }
    )

    expect(written).not.toContain("data-sixb-")
    expect(written).not.toContain("data-currency-field")
    expect(written).toContain("<h1>Repair</h1>")
    expect(written).toContain("<p>3</p>")
    expect(written).toContain("<li><span>SC-1</span></li>")
  })

  // Reproduce by formatting Number(value) in documentData: an empty note shows as 0, and an amount
  // with no currency shows three decimals.
  test("formats only what holds a number, and money to the cent", () => {
    const written = fillDocumentHtml(
      html(
        `<p data-sixb-field="amount" data-format="money">$0</p>
<p data-sixb-field="note" data-format="number">n/a</p>`
      ),
      { holder, queries: {} },
      { plain: true }
    )

    expect(written).toContain(">1.23</p>")
    expect(written).toContain('data-format="number"></p>')
  })
})
