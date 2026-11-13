import { describe, expect, test } from "bun:test"
import * as Y from "yjs"
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
