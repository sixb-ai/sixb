import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import * as Y from "yjs"
import type { BlockNode } from "../src/artifacts/live/blocks"
import {
  createArtifactDocument,
  documentFiles,
  holdPage,
  LIVE_FILES,
  mergeIntoDocument,
  readChange,
} from "../src/artifacts/live/document"
import {
  isPageEntry,
  mergePageSources,
  PAGE_BODY,
  pageBlocks,
  pageEntry,
  pageEntryHtml,
  pageHtml,
} from "../src/artifacts/live/page"

// A designed document's page as the blocks its editor edits in the frame, and back.

const PROPOSAL = readFileSync(
  join(
    import.meta.dir,
    "../../agent/src/skills/sixb-artifacts/examples/document/service-proposal/document.html"
  ),
  "utf8"
)

const PAGE = `<!doctype html>
<html lang="en">
<head>
  <link rel="stylesheet" href="design.css">
</head>
<body class="report">
  <section class="cover">
    <h1>Harbor &amp; Pine</h1>
    <p class="lede">Prepared for <strong>Harbor
      &amp; Pine</strong> by <a href="https://example.com" class="link">Fieldwise</a>.</p>
    <img src="images/logo.svg" alt="Logo">
    <p>Line one<br>line two</p>
    <p>A fee of <span data-sixb-field="fee">$4,000</span>.</p>
    <div class="divider"></div>
  </section>
</body>
</html>
`

/** The page of `source`, which must be one an editor holds. */
function page(source: string) {
  const read = pageBlocks(source)
  if (!read) throw new Error("Expected a page an editor holds.")
  return read
}

function section(source: string): BlockNode {
  return page(source).blocks[0] as BlockNode
}

describe("a designed document's page as blocks", () => {
  test("holds the body as the elements it is made of, spaced as they show", () => {
    const cover = section(PAGE)
    expect(cover).toMatchObject({
      type: "box",
      attrs: { tag: "section", open: '<section class="cover">', close: "</section>" },
    })
    const [heading, lede, logo, lines, fee, divider] = cover.content ?? []

    expect(heading).toEqual({
      type: "textBlock",
      attrs: {
        tag: "h1",
        open: "<h1>",
        close: "</h1>",
        before: "\n    ",
        inner: "Harbor &amp; Pine",
      },
      content: [{ type: "text", text: "Harbor & Pine" }],
    })
    // Words are spaced as they show; the source's line break inside the mark is one space.
    expect(lede?.content).toEqual([
      { type: "text", text: "Prepared for " },
      {
        type: "text",
        text: "Harbor & Pine",
        marks: [{ type: "strong", attrs: { open: "<strong>", close: "</strong>" } }],
      },
      { type: "text", text: " by " },
      {
        type: "text",
        text: "Fieldwise",
        marks: [
          {
            type: "a",
            attrs: { open: '<a href="https://example.com" class="link">', close: "</a>" },
          },
        ],
      },
      { type: "text", text: "." },
    ])
    expect(logo).toEqual({
      type: "image",
      attrs: { source: '<img src="images/logo.svg" alt="Logo">', before: "\n    " },
    })
    expect(lines?.content?.map((node) => node.type)).toEqual(["text", "hardBreak", "text"])
    // A field shows live data: it is kept whole among the words around it.
    expect(fee?.content?.[1]).toEqual({
      type: "rawInline",
      attrs: { source: '<span data-sixb-field="fee">$4,000</span>' },
    })
    expect(divider).toMatchObject({ type: "raw", attrs: { source: '<div class="divider"></div>' } })
  })

  test("writes a page back as its source, byte for byte", () => {
    for (const source of [PAGE, PROPOSAL]) expect(pageHtml(page(source))).toBe(source)
  })

  test("keeps whatever its parser would mend, or cannot edit, exactly as it was", () => {
    const sources = [
      // Words beside blocks, at the top and inside a box.
      "<body>loose words<p>a</p> more</body>",
      "<body><div>words <p>and a block</p></div></body>",
      // A table without its tbody, which the parser adds.
      "<body><table><tr><td>a</td></tr></table></body>",
      // Misnested formatting, which the parser rearranges.
      "<body><p><b>bold <i>both</b> italic</i></p></body>",
      // Comments, entities, a no-break space, and characters the source leaves unescaped.
      "<body>\n<!-- a note -->\n<p>a &lt;b&gt; &amp; c&nbsp;d &copy; > e</p></body>",
      // Whitespace kept as written.
      "<body><pre>\n  indented\n    code</pre></body>",
      // Implied end tags.
      "<body><ul><li>one<li>two</ul><p>para<p>next</body>",
      // A span inside a span, an empty span, an inline SVG.
      '<body><p><span class="a">x <span class="b">y</span></span> <span class="dot"></span> <svg viewBox="0 0 1 1"><path d="M0 0"/></svg></p></body>',
      // A custom element, an embed, and a repeated row of live data.
      '<body><sixb-embed address="artifact:a"></sixb-embed><table><tbody><tr data-sixb-each="items"><td data-sixb-field="title">T</td></tr></tbody></table></body>',
      // Nothing after the body but whitespace and the end tags.
      "<!doctype html><html><body>\n  <p>x</p>\n</body>\n</html>\n\n",
      // An empty body.
      "<body></body>",
    ]
    for (const source of sources) expect(pageHtml(page(source))).toBe(source)
  })

  test("keeps a mark around a field or a picture whole, so an edit beside it keeps it", () => {
    const source =
      '<body><p>Fee: <strong><span data-sixb-field="fee">$1</span></strong> <a href="/"><img src="i.png"> Home</a>.</p></body>'
    const read = page(source)
    const paragraph = read.blocks[0] as BlockNode
    expect(paragraph.content?.map((node) => node.type)).toEqual([
      "text",
      "rawInline",
      "text",
      "rawInline",
      "text",
    ])
    const edited: BlockNode = {
      ...paragraph,
      content: [...(paragraph.content ?? []), { type: "text", text: " More." }],
    }
    expect(pageHtml({ ...read, blocks: [edited] })).toBe(
      '<body><p>Fee: <strong><span data-sixb-field="fee">$1</span></strong> <a href="/"><img src="i.png"> Home</a>. More.</p></body>'
    )
  })

  test("holds no page whose body has no tag of its own, or anything past it", () => {
    expect(pageBlocks("<p>no body tag</p>")).toBeNull()
    expect(pageBlocks("<body><p>a</p></body><p>after</p>")).toBeNull()
  })

  test("writes a changed block as the editor holds it, and spaces new blocks as their neighbors", () => {
    const read = page(PAGE)
    const cover = read.blocks[0] as BlockNode
    const [heading, lede, ...rest] = cover.content ?? []
    const changedLede: BlockNode = {
      ...(lede as BlockNode),
      content: [...((lede as BlockNode).content ?? []), { type: "text", text: " Thanks." }],
    }
    // As an editor makes them: no spacing, no source of their words.
    const added: BlockNode = {
      type: "textBlock",
      attrs: { tag: "p", open: "<p>", close: "</p>" },
      content: [{ type: "text", text: "A new paragraph" }],
    }
    const list: BlockNode = {
      type: "box",
      attrs: { tag: "ul", open: "<ul>", close: "</ul>" },
      content: [
        {
          type: "textBlock",
          attrs: { tag: "li", open: "<li>", close: "</li>" },
          content: [{ type: "text", text: "An item" }],
        },
      ],
    }
    const written = pageHtml({
      ...read,
      blocks: [{ ...cover, content: [heading as BlockNode, changedLede, added, list, ...rest] }],
    })

    expect(written).toContain(
      '<p class="lede">Prepared for <strong>Harbor &amp; Pine</strong> by <a href="https://example.com" class="link">Fieldwise</a>. Thanks.</p>\n    <p>A new paragraph</p>\n    <ul>\n      <li>An item</li>\n    </ul>\n    <img'
    )
    // Everything else is as it was.
    const untouched = (source: string) =>
      source
        .replace(/<p class="lede">[\s\S]*?<\/p>/, "")
        .replace(/<p>A new[\s\S]*?<\/ul>\n {4}/, "")
    expect(untouched(written)).toBe(untouched(PAGE))
  })
})

describe("a designed document held live", () => {
  const files = (html: string) =>
    new Map([
      ["document.html", { text: html }],
      ["design.css", { text: "body { color: black }" }],
    ])

  test("holds document.html as a page whose blocks are a fragment, and writes it back the same", () => {
    const doc = createArtifactDocument("document", files(PROPOSAL))
    const entry = doc.getMap(LIVE_FILES).get("document.html")
    expect(isPageEntry(entry)).toBe(true)
    expect((entry as Y.Map<unknown>).get(PAGE_BODY)).toBeInstanceOf(Y.XmlFragment)
    expect(documentFiles(doc).get("document.html")).toEqual({ text: PROPOSAL })
    expect(documentFiles(doc).get("design.css")).toEqual({ text: "body { color: black }" })
  })

  test("holds a page an editor cannot hold whole as text", () => {
    const doc = createArtifactDocument("document", files("<p>no body tag</p>"))
    expect(doc.getMap(LIVE_FILES).get("document.html")).toBeInstanceOf(Y.Text)
  })

  test("merges a write made from earlier files with what its editors typed since", () => {
    const doc = createArtifactDocument("document", files(PROPOSAL))
    const body = (doc.getMap(LIVE_FILES).get("document.html") as Y.Map<unknown>).get(
      PAGE_BODY
    ) as Y.XmlFragment
    const sections = body.toArray() as Y.XmlElement[]

    // Someone types in the callout of the first section's page.
    const typed = textContaining(body, "The same business")
    typed.insert(0, "Live: ")

    const next = PROPOSAL.replace("Scope of work", "Scope").replace(
      "Invoices are due within 30 days.",
      "Invoices are due within 15 days."
    )
    mergeIntoDocument(doc, files(PROPOSAL), files(next))

    const merged = documentFiles(doc).get("document.html")
    expect(merged).toEqual({
      text: next.replace(
        /<p>The same business,[\s\S]*?<\/p>/,
        "<p>Live: The same business, running more smoothly, with work moving through the company without Dana carrying all of it.</p>"
      ),
    })
    // The sections it did not change are the same elements, and so is the one it changed in
    // part: only the heading inside it was replaced.
    const after = body.toArray() as Y.XmlElement[]
    expect(after.length).toBe(sections.length)
    for (const [at, element] of after.entries()) expect(element).toBe(sections[at] as Y.XmlElement)
    expect(textContaining(body, "Live: The same")).toBe(typed)
  })

  test("takes a write that spaces blocks anew, even where it changed nothing else", () => {
    const doc = createArtifactDocument("document", files(PAGE))
    // The heading only moves in; a paragraph elsewhere changes.
    const next = PAGE.replace("\n    <h1>", "\n      <h1>").replace("Line one", "First line")
    mergeIntoDocument(doc, files(PAGE), files(next))
    expect(documentFiles(doc).get("document.html")).toEqual({ text: next })
  })

  test("holds a page as text from when a write makes it one an editor cannot hold whole", () => {
    const doc = createArtifactDocument("document", files(PROPOSAL))
    const broken = PROPOSAL.replace("<body>", "")
    mergeIntoDocument(doc, files(PROPOSAL), files(broken))
    expect(doc.getMap(LIVE_FILES).get("document.html")).toBeInstanceOf(Y.Text)
    expect(documentFiles(doc).get("document.html")).toEqual({ text: broken })
  })

  test("reads a page entry back as its source", () => {
    const entry = pageEntry(PAGE)
    const doc = new Y.Doc()
    doc.getMap("files").set("document.html", entry)
    expect(pageEntryHtml(entry as Y.Map<unknown>)).toBe(PAGE)
  })
})

describe("a designed document's page, merged", () => {
  const PAGE_OF = (body: string) => `<!doctype html>\n<html>\n<body>\n${body}\n</body>\n</html>\n`

  // Reproduce by merging pages as text in mergeIntoDocument: what one side typed into a block the
  // other moved is left as loose words at the top of the body.
  test("merges block by block, so a block one side moved keeps the words the other typed", () => {
    const base = PAGE_OF("<p>one</p>\n<p>two</p>")
    const typed = PAGE_OF("<p>one!</p>\n<p>two</p>")
    const swapped = PAGE_OF("<p>two</p>\n<p>one</p>")
    const merged = mergePageSources(base, typed, swapped) as string
    expect(pageBlocks(merged)?.blocks.every((block) => block.type === "textBlock")).toBe(true)
    expect(merged).toContain("<p>one!</p>")

    // One side takes a paragraph out while the other edits it: the edit stays, as a block.
    const deleted = PAGE_OF("<p>one</p>")
    const edited = PAGE_OF("<p>one</p>\n<p>two, more</p>")
    expect(mergePageSources(base, deleted, edited)).toBe(PAGE_OF("<p>one</p>\n<p>two, more</p>"))
    // Both change one paragraph's words, in different places.
    const ours = PAGE_OF("<p>one, ours</p>\n<p>two</p>")
    const theirs = PAGE_OF("<p>One</p>\n<p>two</p>")
    expect(mergePageSources(base, ours, theirs)).toBe(PAGE_OF("<p>One, ours</p>\n<p>two</p>"))
    // A list one side took out while the other added an item to it leaves no stray item.
    const list = PAGE_OF("<ul>\n  <li>a</li>\n</ul>\n<p>x</p>")
    const noList = PAGE_OF("<p>x</p>")
    const longer = PAGE_OF("<ul>\n  <li>a</li>\n  <li>c</li>\n</ul>\n<p>x</p>")
    const result = mergePageSources(list, noList, longer) as string
    expect(pageBlocks(result)?.blocks.map((block) => block.attrs?.tag)).toEqual(["ul", "p"])
  })

  // Reproduce by dropping holdPage from loadArtifactDocument, or the page branch for a Y.Text in
  // mergeIntoDocument: a document kept as text before pages stays text, edited word by word.
  test("holds as a page a document.html kept as text, once it reads as one", () => {
    const doc = createArtifactDocument(
      "document",
      new Map([["document.html", { text: "<p>x</p>" }]])
    )
    expect(doc.getMap(LIVE_FILES).get("document.html")).toBeInstanceOf(Y.Text)
    mergeIntoDocument(
      doc,
      new Map([["document.html", { text: "<p>x</p>" }]]),
      new Map([["document.html", { text: PAGE }]])
    )
    expect(isPageEntry(doc.getMap(LIVE_FILES).get("document.html"))).toBe(true)
    expect(documentFiles(doc).get("document.html")).toEqual({ text: PAGE })

    // A document stored with its page as text: two servers loading it make the same change.
    const stored = new Y.Doc()
    stored.getMap("artifact").set("kind", "document")
    stored.getMap(LIVE_FILES).set("document.html", new Y.Text(PAGE))
    const state = Y.encodeStateAsUpdate(stored)
    const [first, second] = [new Y.Doc(), new Y.Doc()]
    for (const each of [first, second]) {
      Y.applyUpdate(each, state)
      holdPage(each, 1234)
    }
    expect(Y.encodeStateAsUpdate(first)).toEqual(Y.encodeStateAsUpdate(second))
    Y.applyUpdate(first, Y.encodeStateAsUpdate(second))
    expect(isPageEntry(first.getMap(LIVE_FILES).get("document.html"))).toBe(true)
    expect(documentFiles(first).get("document.html")).toEqual({ text: PAGE })
  })

  // Reproduce by dropping the rank check from formatsWords: an edit writes the link outside the
  // badge, splitting the badge in two.
  test("keeps a styled mark around a mark written outside it whole", () => {
    const source = '<body><p><span class="badge">New <a href="#">see</a></span> other</p></body>'
    const read = page(source)
    const paragraph = read.blocks[0] as BlockNode
    expect(paragraph.content?.[0]?.type).toBe("rawInline")
    const edited = {
      ...paragraph,
      content: [...(paragraph.content ?? []), { type: "text", text: "!" }],
    }
    expect(pageHtml({ ...read, blocks: [edited] })).toBe(
      '<body><p><span class="badge">New <a href="#">see</a></span> other!</p></body>'
    )
    // Plain marks read the same either way round, and stay editable.
    expect(page("<body><p><em><strong>x</strong></em></p></body>").blocks[0]?.content?.[0]).toEqual(
      {
        type: "text",
        text: "x",
        marks: [
          { type: "em", attrs: { open: "<em>", close: "</em>" } },
          { type: "strong", attrs: { open: "<strong>", close: "</strong>" } },
        ],
      }
    )
  })

  // Reproduce by reading the whole document in readChange: nothing fails, but a keystroke costs
  // the whole page. The check: what a change leaves unreadable still throws.
  test("reads back what a change touched, and throws where the document would", () => {
    const doc = createArtifactDocument("document", new Map([["document.html", { text: PROPOSAL }]]))
    const body = (doc.getMap(LIVE_FILES).get("document.html") as Y.Map<unknown>).get(
      PAGE_BODY
    ) as Y.XmlFragment
    expect(() =>
      readChange(doc, () => textContaining(body, "Invoices").insert(0, "x"))
    ).not.toThrow()
    // A block added, as an editor adds one, from another copy of the document.
    const other = new Y.Doc()
    Y.applyUpdate(other, Y.encodeStateAsUpdate(doc))
    const otherBody = (other.getMap(LIVE_FILES).get("document.html") as Y.Map<unknown>).get(
      PAGE_BODY
    ) as Y.XmlFragment
    const before = Y.encodeStateVector(doc)
    const paragraph = new Y.XmlElement("textBlock")
    paragraph.setAttribute("tag", "p")
    paragraph.insert(0, [new Y.XmlText("New")])
    otherBody.insert(0, [paragraph])
    const added = Y.encodeStateAsUpdate(other, before)
    expect(() => readChange(doc, () => Y.applyUpdate(doc, added))).not.toThrow()
    expect(pageEntryHtml(doc.getMap(LIVE_FILES).get("document.html") as Y.Map<unknown>)).toContain(
      "<p>New</p>"
    )
    // And a block of a Markdown document.
    const md = createArtifactDocument("document", new Map([["document.md", { text: "# A\n" }]]))
    const fragment = md.getMap(LIVE_FILES).get("document.md") as Y.XmlFragment
    expect(() =>
      readChange(md, () => fragment.insert(1, [new Y.XmlElement("paragraph")]))
    ).not.toThrow()
    expect(() =>
      readChange(doc, () => doc.getMap(LIVE_FILES).set("boards/x.html", new Y.Map()))
    ).toThrow()
  })
})

/** The text in a fragment that holds `words`. */
function textContaining(parent: Y.XmlFragment, words: string): Y.XmlText {
  for (const child of parent.toArray()) {
    if (child instanceof Y.XmlText && child.toString().includes(words)) return child
    if (child instanceof Y.XmlElement) {
      try {
        return textContaining(child, words)
      } catch {}
    }
  }
  throw new Error(`No text holds '${words}'.`)
}
