import { describe, expect, test } from "bun:test"
import * as Y from "yjs"
import type { BlockNode } from "../src/artifacts/live/blocks"
import {
  blocksToMarkdown,
  fragmentMarkdown,
  markdownFragment,
  markdownToBlocks,
  patchFragment,
} from "../src/artifacts/live/blocks"
import {
  createArtifactDocument,
  documentFiles,
  LIVE_FILES,
  mergeIntoDocument,
  readChange,
} from "../src/artifacts/live/document"

// A Markdown document as the blocks its editor edits, and back.

const DOCUMENT = `# Field app pilot

A short **lede** with *emphasis*, \`code\`, ~~gone~~ and a [link](https://example.com "Example").

> [!WARNING]
> Callouts keep their kind.
> And their lines.

> A plain quote.

- One
- Two
  - Nested

3. Third
4. Fourth

- [x] Done
- [ ] Not yet

\`\`\`ts title="a.ts"
const x = 1
\`\`\`

| Region | Visits |
| :--- | ---: |
| North | 1,284 |

![The depot](images/depot.png "Depot 4, Ridge Road")

---

Text with a footnote[^1], a line\\
break and <b>html</b>.

[^1]: The footnote.
`

describe("a Markdown document as blocks", () => {
  // Reproduce by dropping a case from markdownToBlocks (callouts, tables, task lists): it is kept
  // as raw Markdown, and the editor cannot edit what it holds.
  test("holds everything the reading view shows as blocks the editor edits", () => {
    const blocks = markdownToBlocks(DOCUMENT).content ?? []
    expect(blocks.map((block) => block.type)).toEqual([
      "heading",
      "paragraph",
      "callout",
      "blockquote",
      "bulletList",
      "orderedList",
      "taskList",
      "codeBlock",
      "table",
      "image",
      "horizontalRule",
      "paragraph",
      "markdown",
    ])
    expect(blocks[2]).toMatchObject({ attrs: { kind: "warning" } })
    expect(blocks[5]).toMatchObject({ attrs: { start: 3 } })
    expect(blocks[6]?.content?.map((item) => item.attrs?.checked)).toEqual([true, false])
    expect(blocks[7]).toMatchObject({ attrs: { language: "ts", meta: 'title="a.ts"' } })
    expect(blocks[8]?.content?.[0]?.content?.map((cell) => [cell.type, cell.attrs?.align])).toEqual(
      [
        ["tableHeader", "left"],
        ["tableHeader", "right"],
      ]
    )
    expect(blocks[9]).toMatchObject({
      attrs: { src: "images/depot.png", alt: "The depot", title: "Depot 4, Ridge Road" },
    })
    expect(blocks[1]?.content).toContainEqual({
      type: "text",
      text: "lede",
      marks: [{ type: "bold" }],
    })
    expect(blocks[1]?.content).toContainEqual({
      type: "text",
      text: "link",
      marks: [
        {
          type: "link",
          attrs: {
            href: "https://example.com",
            target: null,
            rel: null,
            class: null,
            title: "Example",
          },
        },
      ],
    })
  })

  // Reproduce by writing callouts with a hard break after their marker, or tables padded to their
  // widest cell: each save rewrites the author's Markdown.
  test("writes Markdown back as it was written, and again the same", () => {
    const written = blocksToMarkdown(markdownToBlocks(DOCUMENT))
    expect(written).toBe(DOCUMENT)

    const padded = "| A | Longer heading |\n|---|:-:|\n| 1 | 2 |\n"
    const once = blocksToMarkdown(markdownToBlocks(padded))
    expect(once).toBe("| A | Longer heading |\n| --- | :---: |\n| 1 | 2 |\n")
    expect(blocksToMarkdown(markdownToBlocks(once))).toBe(once)
  })
})

describe("a Markdown document held live", () => {
  // Reproduce by holding document.md as Y.Text in createArtifactDocument: the editor's
  // collaboration has no fragment to bind to.
  test("holds document.md as a fragment of elements and marked text, as the editor encodes it", () => {
    const doc = createArtifactDocument("document", new Map([["document.md", { text: DOCUMENT }]]))
    const fragment = doc.getMap(LIVE_FILES).get("document.md")
    if (!(fragment instanceof Y.XmlFragment)) throw new Error("Expected a fragment.")

    const heading = fragment.get(0) as Y.XmlElement<{ level: number }>
    expect(heading.nodeName).toBe("heading")
    expect(heading.getAttributes()).toEqual({ level: 1 })
    const lede = (fragment.get(1) as Y.XmlElement).get(0) as Y.XmlText
    expect(lede.toDelta()).toContainEqual({ insert: "lede", attributes: { bold: {} } })
    expect(documentFiles(doc).get("document.md")).toEqual({ text: DOCUMENT })
  })

  // Reproduce by replacing the whole fragment in patchFragment: the heading another editor's
  // caret is in is a new element, and their history no longer applies to it.
  test("takes a change to its Markdown block by block, keeping the blocks that did not change", () => {
    const doc = new Y.Doc()
    doc.getMap(LIVE_FILES).set("document.md", markdownFragment(DOCUMENT))
    const fragment = doc.getMap(LIVE_FILES).get("document.md") as Y.XmlFragment
    const heading = fragment.get(0)

    patchFragment(fragment, DOCUMENT.replace("Callouts keep", "Callouts always keep"))

    expect(fragment.get(0)).toBe(heading)
    expect(fragmentMarkdown(fragment)).toBe(
      DOCUMENT.replace("Callouts keep", "Callouts always keep")
    )
  })

  // Reproduce by setting the written Markdown over the fragment in mergeIntoDocument: what the
  // editor typed since is lost.
  test("merges a write made from earlier files with what its editors typed since", () => {
    const base = "# Plan\n\nThree weeks in North.\n\n- Install the app\n"
    const doc = createArtifactDocument("document", new Map([["document.md", { text: base }]]))
    const fragment = doc.getMap(LIVE_FILES).get("document.md") as Y.XmlFragment
    // An editor types into the paragraph.
    ;((fragment.get(1) as Y.XmlElement).get(0) as Y.XmlText).insert(0, "About ")

    mergeIntoDocument(
      doc,
      new Map([["document.md", { text: base }]]),
      new Map([["document.md", { text: base.replace("Install the app", "Install the field app") }]])
    )

    expect(fragmentMarkdown(fragment)).toBe(
      "# Plan\n\nAbout Three weeks in North.\n\n- Install the field app\n"
    )
  })
})

describe("a Markdown document's edge cases", () => {
  const roundTrip = (markdown: string) => blocksToMarkdown(markdownToBlocks(markdown))
  /** What an edit elsewhere writes back: each block as the editor holds it, written again. */
  const afterAnEdit = (markdown: string) =>
    roundTrip(`${roundTrip(markdown)}\nEdited.\n`).replace(/\nEdited\.\n$/, "")

  // Reproduce by dropping `modelledThroughout` from markdownToBlocks' marks: the mark is held on
  // the words around the markup alone, and its placeholder is escaped as it is written.
  test("keeps a mark or a link around markup it does not model whole", () => {
    for (const source of [
      "**Step 1:<br> open it**\n",
      "**See [^1] below**\n\n[^1]: The note.\n",
      "Press **<kbd>Ctrl</kbd> now**.\n",
      "[![build](badge.svg)](https://ci.example.com)\n",
      "[<kbd>Ctrl</kbd>](https://example.com)\n",
    ]) {
      expect(roundTrip(source)).toBe(source)
      expect(afterAnEdit(source)).toBe(source)
    }
  })

  // Reproduce by writing a cell's breaks as Markdown breaks in blocksToMarkdown: a cell is one
  // line, and its second line is joined to the first.
  test("writes a table cell's line breaks as HTML, and reads them back as breaks", () => {
    const doc = markdownToBlocks("| A |\n| --- |\n| x |\n")
    const cell = doc.content?.[0]?.content?.[1]?.content?.[0] as BlockNode
    const edited: BlockNode = {
      ...cell,
      content: [
        {
          type: "paragraph",
          content: [
            { type: "text", text: "first line" },
            { type: "hardBreak" },
            { type: "text", text: "second line" },
          ],
        },
      ],
    }
    const table = doc.content?.[0] as BlockNode
    const written = blocksToMarkdown({
      type: "doc",
      content: [
        {
          ...table,
          content: [
            table.content?.[0] as BlockNode,
            { ...(table.content?.[1] as BlockNode), content: [edited] },
          ],
        },
      ],
    })
    expect(written).toBe("| A |\n| --- |\n| first line<br>second line |\n")
    expect(roundTrip(written)).toBe(written)
    const read = markdownToBlocks(written).content?.[0]?.content?.[1]?.content?.[0]?.content?.[0]
    expect(read?.content?.map((node) => node.type)).toEqual(["text", "hardBreak", "text"])
  })

  // Reproduce by requiring a line end after the marker in CALLOUT: the page shows a callout,
  // and the first edit writes it back as an escaped quote.
  test("reads a callout with words on its marker's line as the page does", () => {
    const [callout] = markdownToBlocks("> [!NOTE] Heads up\n> More.\n").content ?? []
    expect(callout).toMatchObject({ type: "callout", attrs: { kind: "note" } })
    expect(roundTrip("> [!NOTE] Heads up\n")).toBe("> [!NOTE]\n> Heads up\n")
  })

  // Reproduce by reading every kept block's source by its offsets: the HTML inside a quote holds
  // the quote's markers, and writes them again wherever it is moved.
  test("keeps what it does not model, within a quote or a list, as Markdown writes it alone", () => {
    const [quote] =
      markdownToBlocks("> <details>\n> <summary>More</summary>\n> </details>\n").content ?? []
    expect(quote?.content?.[0]).toEqual({
      type: "markdown",
      attrs: { source: "<details>\n<summary>More</summary>\n</details>" },
    })
    const loose = "- [x] Done [a]\n\n  [a]: https://example.com\n"
    expect(roundTrip(roundTrip(loose))).toBe(roundTrip(loose))
  })

  // Reproduce by dropping FRONT_MATTER: its fences read as a rule and a heading.
  test("keeps front matter as it was written", () => {
    const source = "---\ntitle: Plan\ntags: [a, b]\n---\n\n# Plan\n"
    expect(roundTrip(source)).toBe(source)
    expect(markdownToBlocks(source).content?.[0]).toEqual({
      type: "markdown",
      attrs: { source: "---\ntitle: Plan\ntags: [a, b]\n---" },
    })
  })

  // Reproduce by holding a mixed list as a task list: its plain items become to-dos.
  test("keeps a list of to-dos and plain items as it was written", () => {
    const source = "- [ ] a to-do\n- a plain item\n"
    expect(markdownToBlocks(source).content?.[0]?.type).toBe("markdown")
    expect(roundTrip(source)).toBe(source)
  })

  // Reproduce by marking verbatim Markdown with a fixed placeholder: words that look like it are
  // replaced.
  test("keeps words that look like where verbatim Markdown goes", () => {
    const source = "Say sixbverbatim0x and <b>hi</b>.\n"
    expect(roundTrip(source)).toBe(source)
  })

  // Reproduce by comparing the Agent's Markdown with the document's in mergeIntoDocument as they
  // were written: every difference in how they are written is merged into the words.
  test("merges an Agent's Markdown written its own way without garbling it", () => {
    const base = "* alpha\n* beta\n* gamma\n\nThis is _very_ important.\n\nNew title\n===\n"
    const doc = createArtifactDocument("document", new Map([["document.md", { text: base }]]))
    const fragment = doc.getMap(LIVE_FILES).get("document.md") as Y.XmlFragment
    // Someone types, so the document writes itself its own way.
    ;((fragment.get(1) as Y.XmlElement).get(0) as Y.XmlText).insert(0, "Note: ")

    const next = base.replace("* beta\n", "").replace("_very_", "__very__")
    mergeIntoDocument(
      doc,
      new Map([["document.md", { text: base }]]),
      new Map([["document.md", { text: next }]])
    )
    expect(fragmentMarkdown(fragment)).toBe(
      "- alpha\n- gamma\n\nNote: This is **very** important.\n\n# New title\n"
    )
  })

  // Reproduce by replacing a changed paragraph whole in patchBlocks: the words someone typed
  // into it meanwhile, still on their way, land in the element taken out.
  test("patches a changed paragraph's words in place, keeping what is typed in it meanwhile", () => {
    const base = "# Plan\n\nThe quick brown fox.\n"
    const server = createArtifactDocument("document", new Map([["document.md", { text: base }]]))
    const client = new Y.Doc()
    Y.applyUpdate(client, Y.encodeStateAsUpdate(server))

    // The client types at the end of the paragraph, before the Agent's change reaches it.
    const typed = (client.getMap(LIVE_FILES).get("document.md") as Y.XmlFragment).get(1)
    ;((typed as Y.XmlElement).get(0) as Y.XmlText).insert(20, " It jumps.")
    patchFragment(
      server.getMap(LIVE_FILES).get("document.md") as Y.XmlFragment,
      "# Plan\n\nThe **quick** brown fox.\n"
    )
    Y.applyUpdate(server, Y.encodeStateAsUpdate(client))
    Y.applyUpdate(client, Y.encodeStateAsUpdate(server))

    for (const doc of [server, client]) {
      expect(fragmentMarkdown(doc.getMap(LIVE_FILES).get("document.md") as Y.XmlFragment)).toBe(
        "# Plan\n\nThe **quick** brown fox. It jumps.\n"
      )
    }
  })
})

describe("a change to a Markdown document, read back", () => {
  // Reproduce by reading an event's changes after its handler in readChange: Yjs throws for a
  // block added, and the server refuses every new paragraph. The other check: what a change leaves
  // unreadable still throws.
  test("reads back the blocks a change touched, and throws where the document would", () => {
    const doc = createArtifactDocument("document", new Map([["document.md", { text: DOCUMENT }]]))
    const fragment = doc.getMap(LIVE_FILES).get("document.md") as Y.XmlFragment
    expect(() =>
      readChange(doc, () => ((fragment.get(1) as Y.XmlElement).get(0) as Y.XmlText).insert(0, "x"))
    ).not.toThrow()
    const other = new Y.Doc()
    Y.applyUpdate(other, Y.encodeStateAsUpdate(doc))
    const before = Y.encodeStateVector(doc)
    const paragraph = new Y.XmlElement("paragraph")
    paragraph.insert(0, [new Y.XmlText("New")])
    ;(other.getMap(LIVE_FILES).get("document.md") as Y.XmlFragment).insert(1, [paragraph])
    const added = Y.encodeStateAsUpdate(other, before)
    expect(() => readChange(doc, () => Y.applyUpdate(doc, added))).not.toThrow()
    expect(fragmentMarkdown(fragment)).toContain("\n\nNew\n\n")
    expect(() =>
      readChange(doc, () => doc.getMap(LIVE_FILES).set("boards/x.html", new Y.Map()))
    ).toThrow()
  })
})
