import { describe, expect, test } from "bun:test"
import { fillDocumentHtml, frozenDocumentHtml } from "../src/artifacts/document-fill"

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

  // Reproduce by unmarking the field before documentData's fill reads its data-currency-field: the
  // amount prints without its currency, "3,260".
  test("prints money in the currency its field reads", () => {
    const written = fillDocumentHtml(
      html(`<p data-sixb-field="total" data-format="money" data-currency-field="currency">$0</p>`),
      { holder: { primaryId: "c1", properties: { total: 3260, currency: "USD" } }, queries: {} },
      { plain: true }
    )

    expect(written).toContain('<p data-format="money">$3,260</p>')
  })
})

describe("a designed document written in for a frozen version", () => {
  const rows = (...names: string[]) => ({
    objects: names.map((name) => ({ primaryId: name, properties: { name } })),
  })
  const proposal = html(
    `<h1 data-sixb-field="title">Title</h1>
<p data-sixb-field="amount">$0</p>
<ul><li data-sixb-each="query:open"><span data-sixb-field="name">SC-1</span></li></ul>
<ol><li data-sixb-each="query:closed"><span data-sixb-field="name">SC-2</span></li></ol>`
  )

  // Reproduce by writing a frozen version's values in plain: the next version holds no field. Or
  // by removing copies' data-sixb-each in documentData's fill: its rows read the object that holds
  // it, not their item.
  test("keeps every field marked, each item's copy, and a list that was empty", () => {
    const kept = fillDocumentHtml(
      proposal,
      {
        holder: { primaryId: "c1", properties: { title: "Repair" }, redactions: { amount: {} } },
        queries: { open: rows("SC-7", "SC-8"), closed: rows() },
      },
      { keep: true }
    )

    expect(kept).toContain('<h1 data-sixb-field="title">Repair</h1>')
    // Hidden, and not locked for whoever reads the next version.
    expect(kept).toContain('<p data-sixb-field="amount">•••</p>')
    expect(kept).toContain(
      '<li data-sixb-each="query:open"><span data-sixb-field="name">SC-7</span></li><li data-sixb-each="query:open"><span data-sixb-field="name">SC-8</span></li>'
    )
    expect(kept).toContain('<li data-sixb-each="query:closed" data-sixb-empty="">')
  })

  // Reproduce by copying each of a repeated element's copies in documentData's fill: the next
  // version shows its rows twice. Or by leaving data-sixb-empty in plain HTML: the frozen version
  // shows the empty list's template.
  test("reads its copies as one repeated element, and shows its own values in plain", () => {
    const kept = fillDocumentHtml(
      proposal,
      { holder, queries: { open: rows("SC-7", "SC-8"), closed: rows() } },
      { keep: true }
    )

    const next = fillDocumentHtml(
      kept,
      { holder, queries: { open: rows("SC-9"), closed: rows("SC-3") } },
      { plain: true }
    )
    expect(next).toContain("<ul><li><span>SC-9</span></li></ul>")
    expect(next).toContain("<ol><li><span>SC-3</span></li></ol>")

    const frozen = frozenDocumentHtml(kept)
    expect(frozen).not.toContain("data-sixb-")
    expect(frozen).toContain("<ul><li><span>SC-7</span></li><li><span>SC-8</span></li></ul>")
    expect(frozen).toContain("<ol></ol>")
  })
})
