import { describe, expect, test } from "bun:test"
import { getSchema } from "@tiptap/core"
import { prosemirrorToYXmlFragment, yXmlFragmentToProseMirrorRootNode } from "@tiptap/y-tiptap"
import * as Y from "yjs"
import { fragmentMarkdown, markdownFragment } from "../../core/src/artifacts/live/blocks"
import { documentSchemaExtensions } from "../src/artifacts/editor/schema"

// The editor's schema and core's blocks are one format: what the server builds of a Markdown
// document, the editor reads whole, and what the editor writes, the server writes back as the
// same Markdown.

const DOCUMENT = `# Field app pilot

A short **lede** with *emphasis*, \`code\`, ~~gone~~ and a [link](https://example.com "Example").

> [!TIP]
> Callouts keep their kind.

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

const schema = getSchema(documentSchemaExtensions())

/** The fragment the server builds of a document's Markdown, in a live document. */
function built(markdown: string): Y.XmlFragment {
  const doc = new Y.Doc()
  doc.getMap("files").set("document.md", markdownFragment(markdown))
  return doc.getMap("files").get("document.md") as Y.XmlFragment
}

/** A fragment's elements and text, as plain data: what two encodings must agree on. */
function dump(type: Y.XmlFragment | Y.XmlElement | Y.XmlText): unknown {
  if (type instanceof Y.XmlText) return type.toDelta()
  const children = type.toArray().map((child) => dump(child as Y.XmlElement))
  if (!(type instanceof Y.XmlElement)) return children
  return { name: type.nodeName, attrs: type.getAttributes(), children }
}

describe("a Markdown document in the editor", () => {
  // Reproduce by naming a node differently on one side (callout as calloutBlock in the schema):
  // reading the fragment throws, and y-prosemirror would drop the block.
  test("reads every block the server builds, and writes back the same Markdown", () => {
    const node = yXmlFragmentToProseMirrorRootNode(built(DOCUMENT), schema)
    expect(node.childCount).toBe(13)

    const written = prosemirrorToYXmlFragment(node, new Y.Doc().getXmlFragment("written"))
    expect(fragmentMarkdown(written)).toBe(DOCUMENT)
  })

  // Reproduce by leaving a default attribute out of what core writes (a cell's colspan): the
  // editor's first edit rewrites every such block, and each collaborator's caret in it jumps.
  test("holds each block as the editor would write it, so opening it changes nothing", () => {
    const server = built(DOCUMENT)
    const node = yXmlFragmentToProseMirrorRootNode(server, schema)
    const written = prosemirrorToYXmlFragment(node, new Y.Doc().getXmlFragment("written"))
    expect(dump(server)).toEqual(dump(written))
  })
})

describe("a Markdown table in the editor", () => {
  // Reproduce by leaving cells' content as TipTap's `block+`: a list made in a cell is written
  // as nothing, its words lost.
  test("holds words alone in its cells, as a Markdown table can", () => {
    for (const cell of [schema.nodes.tableCell, schema.nodes.tableHeader]) {
      expect(cell?.contentMatch.matchType(schema.nodes.paragraph as never)).toBeTruthy()
      expect(cell?.contentMatch.matchType(schema.nodes.bulletList as never)).toBeFalsy()
      expect(cell?.contentMatch.matchType(schema.nodes.image as never)).toBeFalsy()
    }
  })
})
