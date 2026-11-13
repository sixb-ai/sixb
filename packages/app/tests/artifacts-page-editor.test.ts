import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { Editor, getSchema } from "@tiptap/core"
import { Collaboration } from "@tiptap/extension-collaboration"
import { DOMParser, DOMSerializer } from "@tiptap/pm/model"
import { TextSelection } from "@tiptap/pm/state"
import { prosemirrorToYXmlFragment, yXmlFragmentToProseMirrorRootNode } from "@tiptap/y-tiptap"
import * as Y from "yjs"
import { frameRuntime } from "../../core/src/artifacts/frames/runtime"
import { PAGE_BODY, pageEntry, pageEntryHtml } from "../../core/src/artifacts/live/page"
import {
  duplicate,
  insertBlock,
  moveTo,
  placeAfter,
  remove,
  turnInto,
} from "../src/artifacts/frame-editor/commands"
import { PageKeys } from "../src/artifacts/frame-editor/keys"
import { FRAME_EDITOR_GLOBAL } from "../src/artifacts/frame-editor/protocol"
import { drawnTag, pageSchemaExtensions, sanitize } from "../src/artifacts/frame-editor/schema"
import { installDom } from "./helpers/dom"

// A designed document's editor and core's page are one format: the editor reads whole what the
// server builds of a page, opening it changes nothing, and each key and command changes the page's
// source only where it acts, in markup that can stand where it goes.

installDom([
  "document",
  "navigator",
  "getComputedStyle",
  "requestAnimationFrame",
  "cancelAnimationFrame",
  "MutationObserver",
  "Node",
  "Element",
  "HTMLElement",
  "HTMLTemplateElement",
  "DocumentFragment",
  "Text",
  "Range",
  "DOMRect",
  "KeyboardEvent",
  "Event",
])

const PROPOSAL = readFileSync(
  join(
    import.meta.dir,
    "../../agent/src/skills/sixb-artifacts/examples/document/service-proposal/document.html"
  ),
  "utf8"
)

const PAGE = `<!doctype html>
<html>
<body>
  <section class="cover">
    <h1 class="title">Harbor &amp; Pine</h1>
    <p class="lede">A fixed fee of <strong>$4,000</strong>.</p>
    <ul>
      <li>One</li>
      <li>Two</li>
    </ul>
  </section>
  <section class="page" id="terms">
    <h2 class="section">Terms</h2>
    <table class="pricing">
      <tbody>
        <tr><td>Setup</td><td>$500</td></tr>
      </tbody>
    </table>
  </section>
</body>
</html>
`

/** A live document holding `source` as the server builds it, and its page's entry. */
function live(source: string) {
  const doc = new Y.Doc()
  doc.getMap("files").set("document.html", pageEntry(source))
  const entry = doc.getMap("files").get("document.html") as Y.Map<unknown>
  return { doc, entry, body: entry.get(PAGE_BODY) as Y.XmlFragment }
}

/** The editor over a live page, as the frame mounts it, without its frame. */
function editorOver(source: string) {
  const page = live(source)
  const editor = new Editor({
    element: document.createElement("div"),
    extensions: [
      ...pageSchemaExtensions(),
      Collaboration.configure({ fragment: page.body }),
      PageKeys,
    ],
  })
  return { ...page, editor, html: () => pageEntryHtml(page.entry) }
}

/** Puts the caret after `words`, or selects them. */
function caret(editor: Editor, words: string, select = false): void {
  let found = -1
  editor.state.doc.descendants((node, pos) => {
    if (found < 0 && node.isText && node.text?.includes(words)) {
      found = pos + (node.text.indexOf(words) as number)
    }
  })
  if (found < 0) throw new Error(`No '${words}'.`)
  const end = found + words.length
  editor.view.dispatch(
    editor.state.tr.setSelection(TextSelection.create(editor.state.doc, select ? found : end, end))
  )
}

/** Puts the caret at the end of the block of words that holds `words`. */
function endOf(editor: Editor, words: string): void {
  const pos = blockOf(editor, words)
  const node = editor.state.doc.nodeAt(pos)
  if (!node) throw new Error(`No block with '${words}'.`)
  editor.view.dispatch(
    editor.state.tr.setSelection(TextSelection.create(editor.state.doc, pos + node.nodeSize - 1))
  )
}

/** A key, as the editor takes it from the keyboard. */
function press(editor: Editor, key: string): void {
  const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true })
  editor.view.someProp("handleKeyDown", (handle) => handle(editor.view, event))
}

/** The position of the innermost block of words whose words start with `words`. */
function blockOf(editor: Editor, words: string): number {
  let found = -1
  editor.state.doc.descendants((node, pos) => {
    if (found < 0 && node.isTextblock && node.textContent.startsWith(words)) found = pos
    return found < 0
  })
  return found
}

describe("a designed document's editor", () => {
  test("reads the page the server builds whole, and writes it back as the server does", () => {
    const schema = getSchema(pageSchemaExtensions())
    const { body } = live(PROPOSAL)
    const node = yXmlFragmentToProseMirrorRootNode(body, schema)
    node.check()

    const doc = new Y.Doc()
    const written = doc.getMap("files")
    const entry = new Y.Map<unknown>()
    written.set("document.html", entry)
    entry.set("head", (live(PROPOSAL).entry.get("head") as string) ?? "")
    entry.set("tail", (live(PROPOSAL).entry.get("tail") as string) ?? "")
    entry.set(PAGE_BODY, prosemirrorToYXmlFragment(node))
    expect(pageEntryHtml(entry)).toBe(PROPOSAL)
  })

  test("changes nothing by opening a page", async () => {
    const { editor, html } = editorOver(PROPOSAL)
    await Bun.sleep(0)
    expect(html()).toBe(PROPOSAL)
    editor.destroy()
  })

  test("starts a plain paragraph with Enter, spaced as the block it follows", () => {
    const { editor, html } = editorOver(PAGE)
    endOf(editor, "A fixed fee")
    press(editor, "Enter")
    editor.commands.insertContent("Next")
    expect(html()).toContain("<strong>$4,000</strong>.</p>\n    <p>Next</p>\n    <ul>")
    editor.destroy()
  })

  test("ends a list with Enter on an empty item", () => {
    const { editor, html } = editorOver(PAGE)
    caret(editor, "Two")
    press(editor, "Enter")
    editor.commands.insertContent("Three")
    press(editor, "Enter")
    press(editor, "Enter")
    editor.commands.insertContent("After")
    expect(html()).toContain("<li>Two</li>\n      <li>Three</li>\n    </ul>\n    <p>After</p>")
    editor.destroy()
  })

  test("merges nothing across the design's boxes with Backspace or Delete", () => {
    const { editor, html } = editorOver(PAGE)
    // At the start of the second section's first block, a heading: it becomes a paragraph.
    caret(editor, "Terms")
    editor.view.dispatch(
      editor.state.tr.setSelection(
        TextSelection.create(editor.state.doc, editor.state.selection.from - 5)
      )
    )
    press(editor, "Backspace")
    expect(html()).toContain('<section class="page" id="terms">\n    <p>Terms</p>')
    // Again: the paragraph stays in its section.
    press(editor, "Backspace")
    expect(html()).toContain('<section class="page" id="terms">\n    <p>Terms</p>')
    // At the end of a cell, Delete takes nothing from the next one.
    caret(editor, "Setup")
    press(editor, "Delete")
    expect(html()).toContain("<tr><td>Setup</td><td>$500</td></tr>")
    editor.destroy()
  })

  test("moves through a table's cells with Tab, selecting each", () => {
    const { editor } = editorOver(PAGE)
    caret(editor, "Setup")
    press(editor, "Tab")
    const { from, to } = editor.state.selection
    expect(editor.state.doc.textBetween(from, to)).toBe("$500")
    editor.destroy()
  })

  test("makes a heading like the page's others, and a table like its tables", () => {
    const { editor, html } = editorOver(PAGE)
    endOf(editor, "A fixed fee")
    press(editor, "Enter")
    insertBlock(editor, "heading1")
    editor.commands.insertContent("Scope")
    caret(editor, "Scope")
    press(editor, "Enter")
    insertBlock(editor, "table")
    expect(html()).toContain('<h1 class="title">Scope</h1>')
    expect(html()).toMatch(/<table class="pricing">\s*<thead>\s*<tr>\s*<th><\/th>/)
    editor.destroy()
  })

  test("puts a new block after a list it is made from, never inside it", () => {
    const { editor, html } = editorOver(PAGE)
    caret(editor, "One")
    insertBlock(editor, "quote")
    editor.commands.insertContent("Quoted")
    expect(html()).toContain("<li>Two</li>\n    </ul>\n    <blockquote>Quoted</blockquote>")
    expect(placeAfter(editor.state.doc, blockOf(editor, "One"))).toBe(blockOf(editor, "Quoted"))
    editor.destroy()
  })

  test("turns a paragraph into a list item and back", () => {
    const { editor, html } = editorOver(PAGE)
    endOf(editor, "A fixed fee")
    turnInto(editor, "bulletList")
    expect(html()).toContain(
      "<ul>\n      <li>A fixed fee of <strong>$4,000</strong>.</li>\n    </ul>"
    )
    turnInto(editor, "paragraph")
    expect(html()).toContain("<p>A fixed fee of <strong>$4,000</strong>.</p>")
    // An item in the middle of a list leaves it between the list's two halves.
    caret(editor, "One")
    press(editor, "Enter")
    editor.commands.insertContent("Middle")
    turnInto(editor, "heading2")
    expect(html()).toMatch(
      /<li>One<\/li>\s*<\/ul>\s*<h2 class="section">Middle<\/h2>\s*<ul>\s*<li>Two<\/li>/
    )
    editor.destroy()
  })

  test("copies a block without its id", () => {
    const { editor, html } = editorOver(PAGE)
    duplicate(editor, editor.state.doc.child(0).nodeSize)
    expect(html()).toMatch(/<section class="page" id="terms">[\s\S]*<section class="page">\s*<h2/)
    editor.destroy()
  })

  test("deletes a box with the last block it held", () => {
    const { editor, html } = editorOver(PAGE)
    remove(editor, blockOf(editor, "Setup"))
    expect(html()).toContain("<tr><td>$500</td></tr>")
    // The row, its body and its table held only that cell: they go with it.
    remove(editor, blockOf(editor, "$500"))
    expect(html()).toContain('<h2 class="section">Terms</h2>\n  </section>')
    editor.destroy()
  })

  test("moves a block where it is dropped", () => {
    const { editor, html } = editorOver(PAGE)
    moveTo(editor, blockOf(editor, "Harbor"), blockOf(editor, "Terms"))
    expect(html()).toMatch(
      /<h1 class="title">Harbor &amp; Pine<\/h1>\s*<h2 class="section">Terms<\/h2>/
    )
    editor.destroy()
  })

  test("pastes what it copies as the blocks it copied, a field of live data among them", () => {
    const { editor } = editorOver(
      '<body><p class="lede">Total: <span data-sixb-field="total">$1</span> due</p></body>'
    )
    const { schema } = editor
    const copied = editor.state.doc.slice(0, editor.state.doc.content.size)
    const holder = document.createElement("div")
    holder.append(DOMSerializer.fromSchema(schema).serializeFragment(copied.content))
    const pasted = DOMParser.fromSchema(schema).parseSlice(holder)
    const paragraph = pasted.content.firstChild
    expect(paragraph?.attrs.open).toBe('<p class="lede">')
    expect(paragraph?.child(1).type.name).toBe("rawInline")
    expect(paragraph?.child(1).attrs.source).toBe('<span data-sixb-field="total">$1</span>')
    editor.destroy()
  })

  test("turns no cell into another kind of block", () => {
    const { editor, html } = editorOver(PAGE)
    caret(editor, "Setup")
    expect(turnInto(editor, "heading1")).toBe(false)
    expect(turnInto(editor, "bulletList")).toBe(false)
    expect(html()).toContain("<tr><td>Setup</td><td>$500</td></tr>")
    editor.destroy()
  })

  test("takes a list along when its only item is dragged out of it", () => {
    const { editor, html } = editorOver(
      "<body><ul><li>Only</li></ul><ol><li>First</li></ol></body>"
    )
    moveTo(editor, blockOf(editor, "Only"), blockOf(editor, "First"))
    expect(html()).toBe("<body><ol><li>Only</li><li>First</li></ol></body>")
    editor.destroy()
  })

  test("draws no markup that could run script, which the live document has not been checked for", () => {
    const template = document.createElement("template")
    template.innerHTML =
      '<div onclick="x()"><img src="a.png" onerror="x()"><a href="javascript:x()">a</a><script>x()</script></div>'
    sanitize(template.content)
    expect(template.innerHTML).toBe('<div><img src="a.png"><a>a</a></div>')
  })

  // Reproduce by testing `drawable`'s address as written, or by drawing a node's tag as the live
  // document names it: a tab inside `javascript:` runs, and a node named `meta` refreshes the frame.
  test("draws no address that runs script however it is spelled, nor any tag that loads a page", () => {
    const template = document.createElement("template")
    template.innerHTML =
      '<a href="java&#x09;script:x()">a</a><svg><set attributeName="href" to="javascript:x()"></set></svg>'
    sanitize(template.content)
    expect(template.innerHTML).toBe("<a>a</a><svg></svg>")
    expect(drawnTag("meta")).toBe("div")
    expect(drawnTag("section")).toBe("section")
    expect(drawnTag('p onclick="x()"')).toBe("div")
  })

  // Reproduce by reading every pasted element but words as a box: a rule becomes a box holding
  // an empty paragraph, and a list's items holding paragraphs lose their list.
  test("pastes a list of paragraphs as a list, and a rule as it was", () => {
    const schema = getSchema(pageSchemaExtensions())
    const holder = document.createElement("div")
    holder.innerHTML = "<ul><li><p>Item one</p></li><li><p>Item two</p></li></ul><hr>"
    const pasted = DOMParser.fromSchema(schema).parse(holder)
    const [list, rule] = pasted.content.content
    expect([list?.type.name, list?.attrs.tag]).toEqual(["box", "ul"])
    expect(list?.firstChild?.attrs.tag).toBe("li")
    expect(list?.firstChild?.firstChild?.attrs.tag).toBe("p")
    expect([rule?.type.name, rule?.attrs.source]).toEqual(["raw", "<hr>"])
  })

  // Reproduce by dropping the cell check from `duplicate`: the table gets a third cell.
  test("copies no cell, which would break its table", () => {
    const { editor, html } = editorOver(PAGE)
    caret(editor, "Setup")
    expect(duplicate(editor, blockOf(editor, "Setup"))).toBe(false)
    expect(html()).toContain("<tr><td>Setup</td><td>$500</td></tr>")
    editor.destroy()
  })

  // Reproduce by dropping the item-of-paragraphs case from Enter: each Enter adds another empty
  // paragraph to the item, and the list never ends.
  test("ends a list of items holding paragraphs with Enter on an empty one", () => {
    const { editor, html } = editorOver(
      "<!doctype html>\n<html>\n<body>\n<ul>\n  <li><p>One</p></li>\n</ul>\n</body>\n</html>\n"
    )
    endOf(editor, "One")
    press(editor, "Enter")
    editor.commands.insertContent("Two")
    press(editor, "Enter")
    press(editor, "Enter")
    editor.commands.insertContent("After")
    const written = html()
    expect(written).toContain("<li><p>One</p></li>")
    expect(written).toMatch(/<li>\s*<p>Two<\/p>\s*<\/li>\s*<\/ul>\s*<p>After<\/p>/)
    editor.destroy()
  })

  // Reproduce by returning true from Tab outside a table: the keyboard never leaves the frame.
  test("lets Tab leave the frame outside a table", () => {
    const { editor } = editorOver(PAGE)
    caret(editor, "Harbor")
    const event = new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true })
    const handled = editor.view.someProp("handleKeyDown", (handle) => handle(editor.view, event))
    expect(handled).toBeFalsy()
    editor.destroy()
  })

  test("is started by the frame's runtime under the name the script leaves it at", () => {
    expect(frameRuntime.toString()).toContain(FRAME_EDITOR_GLOBAL)
  })
})
