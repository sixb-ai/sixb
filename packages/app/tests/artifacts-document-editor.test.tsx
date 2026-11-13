import { describe, expect, test } from "bun:test"
import { act, render, waitFor } from "@testing-library/react"
import type { Editor } from "@tiptap/core"
import { Awareness } from "y-protocols/awareness"
import * as Y from "yjs"
import { fragmentMarkdown, markdownFragment } from "../../core/src/artifacts/live/blocks"
import { blockTypes, findBlockTypes } from "../src/artifacts/editor/blocks"
import { DocumentEditor } from "../src/artifacts/editor/document-editor"
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
    readonly editable?: boolean
    readonly uploadImage?: (file: File) => Promise<{ src: string; alt: string }>
  } = {}
) {
  const document = live()
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
    const found = view.container.querySelector(".ProseMirror") as
      | (HTMLElement & { editor?: Editor })
      | null
    if (!found?.editor) throw new Error("The editor is not ready.")
    return found
  })
  return { ...document, view, editor: element.editor as Editor, element }
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

describe("the document editor", () => {
  // Reproduce by leaving Collaboration out of the editor's extensions: what is typed stays in the
  // page, and the live document, which the server writes back, never changes.
  test("types into the live document, which the server writes back as the same Markdown, changed only there", async () => {
    const { editor, fragment } = await open()

    act(() => {
      editor
        .chain()
        .setTextSelection(endOf(editor, "Three weeks in North."))
        .insertContent(" Then Harbor.")
        .run()
      editor
        .chain()
        .setTextSelection(endOf(editor, "Load the jobs"))
        .splitListItem("listItem")
        .insertContent("Run the first job")
        .run()
    })

    expect(fragmentMarkdown(fragment)).toBe(`# Pilot plan

Three weeks in North. Then Harbor.

## Steps

- Install the app
- Load the jobs
- Run the first job
`)
  })

  // Reproduce by dropping the `editable` prop from the editor: a reader who only watches can type
  // into the document, and their words reach no one.
  test("lets a reader who may not change it read it, but not type into it", async () => {
    const { editor, element } = await open({ editable: false })
    expect(editor.isEditable).toBe(false)
    expect(element.getAttribute("contenteditable")).toBe("false")
  })

  // Reproduce by giving the drag handle a new position object each render: registering its plugin
  // again reconfigures the editor, and the `/` menu closes as soon as it opens.
  test("opens the / menu on a typed slash, and makes the block chosen in its place", async () => {
    const { editor, fragment } = await open()
    act(() => {
      editor.chain().focus().setTextSelection(endOf(editor, "Three weeks in North.")).run()
      editor.chain().splitBlock().insertContent("/").run()
    })
    const menu = await waitFor(() => {
      const found = document.querySelector('[role="listbox"]')
      if (!found?.querySelector('[role="option"]')) throw new Error("No / menu yet.")
      return found
    })
    act(() => {
      editor.commands.insertContent("head")
    })
    await waitFor(() => {
      const first = menu.ownerDocument.querySelector('[role="option"][aria-selected="true"]')
      if (!first?.textContent?.startsWith("Heading 1")) throw new Error("Not filtered yet.")
    })
    act(() => {
      editor.view.dom.dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })
      )
    })
    act(() => {
      editor.view.dom.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }))
      editor.commands.insertContent("Why North")
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
      editor.commands.setTextSelection(endOf(editor, "Three weeks in North."))
    })
    const picture = new File([new Uint8Array([137, 80, 78, 71])], "depot.png", {
      type: "image/png",
    })
    const paste = { clipboardData: { files: [picture], getData: () => "" }, preventDefault() {} }
    await act(async () => {
      editor.view.someProp("handlePaste", (handle) =>
        handle(editor.view, paste as never, null as never)
      )
      await new Promise((resolve) => setTimeout(resolve, 0))
    })

    expect(uploaded).toEqual(["depot.png"])
    expect(fragmentMarkdown(fragment)).toContain("![Depot](images/depot-abcdef.png)")
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
