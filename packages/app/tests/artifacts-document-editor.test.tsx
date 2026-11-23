import { describe, expect, test } from "bun:test"
import { act, render, waitFor } from "@testing-library/react"
import { Awareness } from "y-protocols/awareness"
import * as Y from "yjs"
import { fragmentMarkdown, markdownFragment } from "../../core/src/artifacts/live/blocks"
import { blockTypes } from "../src/artifacts/editor/blocks"
import { insertContentAt } from "../src/artifacts/editor/core/commands"
import { type Editor, editorOf } from "../src/artifacts/editor/core/editor"
import { TextSelection } from "../src/artifacts/editor/core/state"
import { DocumentEditor } from "../src/artifacts/editor/document-editor"
import { findBlockTypes } from "../src/artifacts/editor/find-blocks"
import { en } from "../src/artifacts/messages"
import { installDom } from "./helpers/dom"

// The document editor, typing into a live document as the server holds it: what is typed reaches
// the Markdown the server writes back, and nothing else in it changes.

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
  "DocumentFragment",
  "Text",
  "Range",
  "DOMRect",
  "KeyboardEvent",
  "ClipboardEvent",
  "Event",
])

const MARKDOWN = `# Pilot plan

Three weeks in North.

## Steps

- Install the app
- Load the jobs
`

function live(markdown = MARKDOWN) {
  const doc = new Y.Doc()
  doc.getMap("files").set("document.md", markdownFragment(markdown))
  const fragment = doc.getMap("files").get("document.md") as Y.XmlFragment
  return { doc, fragment, awareness: new Awareness(doc) }
}

async function open(
  options: {
    readonly markdown?: string
    readonly editable?: boolean
    readonly uploadImage?: (file: File) => Promise<{ src: string; alt: string }>
  } = {}
) {
  const document = live(options.markdown)
  const view = render(
    <DocumentEditor
      fragment={document.fragment}
      awareness={document.awareness}
      editable={options.editable ?? true}
      imageSource={() => null}
      messages={en.editor}
      {...(options.uploadImage ? { uploadImage: options.uploadImage } : {})}
    />
  )
  const element = await waitFor(() => {
    const found = view.container.querySelector<HTMLElement>(".sixb-editor")
    if (!found || !editorOf(found)) throw new Error("The editor is not ready.")
    return found
  })
  return { ...document, view, editor: editorOf(element) as Editor, element }
}

/** The position just inside the end of the block that holds `text`. */
function endOf(editor: Editor, text: string): number {
  let at = -1
  editor.state.doc.descendants((node, pos) => {
    if (at < 0 && node.isTextblock && node.textContent.includes(text)) at = pos + node.nodeSize - 1
  })
  if (at < 0) throw new Error(`No block holds '${text}'.`)
  return at
}

/** Puts the caret at `pos`. */
function caret(editor: Editor, pos: number): void {
  editor.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, pos)))
}

/** Types `text` over the selection. */
function type(editor: Editor, text: string): void {
  const { from, to } = editor.state.selection
  editor.run(insertContentAt({ from, to }, text))
}

/** A key, as the editor takes it from the keyboard. */
function press(editor: Editor, key: string): void {
  editor.view.dom.dispatchEvent(
    new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true })
  )
}

/** A paste of `data` into the editor, as the browser hands it over. */
function paste(
  editor: Editor,
  data: { readonly text?: string; readonly html?: string; readonly files?: readonly File[] }
): void {
  const event = new Event("paste", { bubbles: true, cancelable: true })
  Object.defineProperty(event, "clipboardData", {
    value: {
      files: data.files ?? [],
      getData: (kind: string) =>
        kind === "text/plain" ? (data.text ?? "") : kind === "text/html" ? (data.html ?? "") : "",
    },
  })
  editor.view.dom.dispatchEvent(event)
}

/** What copying the selection puts on the clipboard as text. */
function copied(editor: Editor): string {
  const written = new Map<string, string>()
  const event = new Event("copy", { bubbles: true, cancelable: true })
  Object.defineProperty(event, "clipboardData", {
    value: {
      clearData: () => written.clear(),
      setData: (kind: string, value: string) => written.set(kind, value),
    },
  })
  editor.view.dom.dispatchEvent(event)
  return written.get("text/plain") ?? ""
}

describe("the document editor", () => {
  // Reproduce by skipping the binding's write in the editor's dispatch: what is typed stays in the
  // page, and the live document, which the server writes back, never changes.
  test("types into the live document, which the server writes back as the same Markdown, changed only there", async () => {
    const { editor, fragment } = await open()

    act(() => {
      caret(editor, endOf(editor, "Three weeks in North."))
      type(editor, " Then Harbor.")
      caret(editor, endOf(editor, "Load the jobs"))
      press(editor, "Enter")
      type(editor, "Run the first job")
    })

    expect(fragmentMarkdown(fragment)).toBe(`# Pilot plan

Three weeks in North. Then Harbor.

## Steps

- Install the app
- Load the jobs
- Run the first job
`)
  })

  // Reproduce by leaving softBreaks out of the editor's plugins: the paragraph's line break is
  // drawn as one, cutting its sentence where the page reads it whole.
  test("reads a paragraph written on several lines as one, as the page does, and writes its lines back", async () => {
    const markdown = `# Q3 operations review

Fill rate held at 91%, up from 88%,
while parts costs rose.

\`\`\`sh
make
make test
\`\`\`
`
    const { editor, element, fragment } = await open({ markdown })

    const paragraph = element.querySelector("p") as HTMLElement
    expect(paragraph.textContent).toBe(
      "Fill rate held at 91%, up from 88%,\nwhile parts costs rose."
    )
    const breaks = [...paragraph.querySelectorAll(".sixb-soft-break")]
    expect(breaks.map((each) => each.textContent)).toEqual(["\n"])
    expect(element.querySelector("pre .sixb-soft-break")).toBeNull()

    act(() => {
      caret(editor, endOf(editor, "Q3 operations review"))
      type(editor, ", North")
    })
    expect(fragmentMarkdown(fragment)).toBe(markdown.replace("review", "review, North"))
  })

  // Reproduce by dropping the `editable` prop from the editor: a reader who only watches can type
  // into the document, and their words reach no one.
  test("lets a reader who may not change it read it, but not type into it", async () => {
    const { editor, element } = await open({ editable: false })
    expect(editor.isEditable).toBe(false)
    expect(element.getAttribute("contenteditable")).toBe("false")
  })

  // Reproduce by leaving Enter out of the `/` menu's keys: Enter splits the line, and the chosen
  // block is never made.
  test("opens the / menu on a typed slash, and makes the block chosen in its place", async () => {
    const { editor, fragment } = await open()
    act(() => {
      editor.focus()
      caret(editor, endOf(editor, "Three weeks in North."))
      press(editor, "Enter")
      type(editor, "/")
    })
    const menu = await waitFor(() => {
      const found = document.querySelector('[role="listbox"]')
      if (!found?.querySelector('[role="option"]')) throw new Error("No / menu yet.")
      return found
    })
    act(() => {
      type(editor, "head")
    })
    await waitFor(() => {
      const first = menu.ownerDocument.querySelector('[role="option"][aria-selected="true"]')
      if (!first?.textContent?.startsWith("Heading 1")) throw new Error("Not filtered yet.")
    })
    act(() => {
      press(editor, "ArrowDown")
    })
    act(() => {
      press(editor, "Enter")
      type(editor, "Why North")
    })

    expect(fragmentMarkdown(fragment)).toContain(
      "Three weeks in North.\n\n## Why North\n\n## Steps"
    )
  })
})

describe("an image a person adds", () => {
  // Reproduce by dropping handlePaste's files case: the pasted picture is lost, and the document
  // holds nothing of it.
  test("is uploaded when pasted, and becomes a figure the document's Markdown points to", async () => {
    const uploaded: string[] = []
    const { editor, fragment } = await open({
      uploadImage: async (file) => {
        uploaded.push(file.name)
        return { src: "images/depot-abcdef.png", alt: "Depot" }
      },
    })
    act(() => {
      caret(editor, endOf(editor, "Three weeks in North."))
    })
    const picture = new File([new Uint8Array([137, 80, 78, 71])], "depot.png", {
      type: "image/png",
    })
    await act(async () => {
      paste(editor, { files: [picture] })
      await new Promise((resolve) => setTimeout(resolve, 0))
    })

    expect(uploaded).toEqual(["depot.png"])
    expect(fragmentMarkdown(fragment)).toContain("![Depot](images/depot-abcdef.png)")
  })
})

describe("what is pasted and copied", () => {
  // Reproduce by inserting pasted Markdown as blocks whatever it holds: bold words pasted into a
  // sentence split it into three paragraphs.
  test("puts Markdown words pasted into a line in that line", async () => {
    const { editor, fragment } = await open()
    act(() => {
      caret(editor, endOf(editor, "Three weeks in North") - 1)
      paste(editor, { text: " with **bold** words" })
    })
    expect(fragmentMarkdown(fragment)).toContain("Three weeks in North with **bold** words.")
  })

  // Reproduce by dropping transformPasted from the editor's props: the web page's logo is kept,
  // and publishing refuses every save of the document from then on.
  test("keeps only the artifact's own pictures of a page pasted from elsewhere", async () => {
    const { editor, fragment, doc } = await open()
    doc.getMap("files").set("images/depot.png", { blobId: "blob_depot", sizeBytes: 4 })
    act(() => {
      caret(editor, endOf(editor, "Three weeks in North."))
      paste(editor, {
        html: '<p>Acme ships the parts.</p><img src="https://acme.com/logo.png" alt="Acme"><img src="images/depot.png" alt="Depot">',
      })
    })

    const markdown = fragmentMarkdown(fragment)
    expect(markdown).toContain("Acme ships the parts.")
    expect(markdown).toContain("![Depot](images/depot.png)")
    expect(markdown).not.toContain("acme.com")
  })

  // Reproduce by leaving withOwnImages out of handlePaste's Markdown case: the badge and the logo
  // a README shows are kept.
  test("keeps only the artifact's own pictures of Markdown pasted as text", async () => {
    const { editor, fragment } = await open()
    const readme = `## Acme

[![Build](https://ci.acme.com/badge.svg)](https://ci.acme.com)

Ships the parts.

![Logo](https://acme.com/logo.png)
`
    act(() => {
      caret(editor, endOf(editor, "Three weeks in North."))
      paste(editor, { text: readme })
    })

    const markdown = fragmentMarkdown(fragment)
    expect(markdown).toContain("Acme\n\nShips the parts.\n\n## Steps")
    expect(markdown).not.toContain("acme.com")
  })

  // Reproduce by dropping the code check from handlePaste: a pasted comment becomes a heading.
  test("pastes into code as it is", async () => {
    const { editor } = await open()
    act(() => {
      const code = editor.schema.nodeType("codeBlock").create({ language: "sh" })
      editor.dispatch(editor.state.tr.replaceWith(0, editor.state.doc.content.size, code))
      caret(editor, 1)
      paste(editor, { text: "# a comment\n- not a list" })
    })
    const only = editor.state.doc.firstChild
    expect(editor.state.doc.childCount).toBe(1)
    expect(only?.type.name).toBe("codeBlock")
    expect(only?.textContent).toBe("# a comment\n- not a list")
  })

  // Reproduce by returning blocksToMarkdown's output alone from clipboardTextSerializer: copied
  // list items put nothing on the clipboard as text.
  test("copies list items as their words when they write no Markdown alone", async () => {
    const { editor } = await open()
    const from = endOf(editor, "Install the app") - "Install the app".length
    const to = endOf(editor, "Load the jobs")
    act(() => {
      editor.dispatch(
        editor.state.tr.setSelection(TextSelection.create(editor.state.doc, from, to))
      )
    })
    const text = copied(editor)
    expect(text).toContain("Install the app")
    expect(text).toContain("Load the jobs")
  })
})

describe("the / menu's blocks", () => {
  test("are found by their name first, then by what else they are called", () => {
    const types = blockTypes(en.editor.blocks)
    expect(findBlockTypes(types, "").map((type) => type.id)).toHaveLength(types.length)
    expect(findBlockTypes(types, "todo").map((type) => type.id)).toEqual(["taskList"])
    expect(findBlockTypes(types, "h")[0]?.id).toBe("heading1")
    expect(findBlockTypes(types, "list").map((type) => type.id)).toEqual([
      "bulletList",
      "orderedList",
      "taskList",
    ])
  })
})
