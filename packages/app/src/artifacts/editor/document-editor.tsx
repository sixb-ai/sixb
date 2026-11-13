import { blocksToMarkdown, markdownToBlocks } from "@sixb/core/artifacts/live"
import { toast } from "@sixb/ui/components"
import { cn } from "@sixb/ui/lib/utils"
import { type Editor, Extension } from "@tiptap/core"
import { Collaboration } from "@tiptap/extension-collaboration"
import { CollaborationCaret } from "@tiptap/extension-collaboration-caret"
import { Placeholder } from "@tiptap/extensions"
import type { Node as ProseMirrorNode } from "@tiptap/pm/model"
import { EditorContent, ReactNodeViewRenderer, useEditor } from "@tiptap/react"
import { useMemo, useRef, useState } from "react"
import type { Awareness } from "y-protocols/awareness"
import type * as Y from "yjs"
import { BlockHandle } from "./block-handle"
import { blockTypes } from "./blocks"
import { CalloutView } from "./callout-view"
import { FigureContext, FigureView } from "./figure-view"
import type { EditorMessages } from "./messages"
import { CalloutNode, documentSchemaExtensions, Figure } from "./schema"
import { SelectionToolbar } from "./selection-toolbar"
import { SlashCommand, SlashMenu, SlashMenuStore } from "./slash-menu"

// A Markdown document edited as a page of notes: click anywhere and type. It edits the live
// document's blocks, so everyone editing it at once sees each other's words and carets, and the
// server writes them back as the document's Markdown. It reads as the document page does, with
// the same type and column.

export interface DocumentEditorProps {
  /** `document.md` as the live document holds it. */
  readonly fragment: Y.XmlFragment
  readonly awareness: Awareness
  /** The reader may change it. */
  readonly editable: boolean
  /** Where one of its image paths is served from. */
  readonly imageSource: (src: string) => string | null
  readonly messages: EditorMessages
  /** The artifact's theme, as the document page applies it. */
  readonly theme?: { readonly className?: string; readonly style?: React.CSSProperties }
  /**
   * Stores an image a person adds as a file of the document, and says where its blocks point to
   * it; throws, saying why, when it cannot. Without it, images are not added.
   */
  readonly uploadImage?: (file: File) => Promise<{ readonly src: string; readonly alt: string }>
}

export function DocumentEditor({
  fragment,
  awareness,
  editable,
  imageSource,
  messages,
  theme,
  uploadImage,
}: DocumentEditorProps) {
  const picker = useRef<HTMLInputElement | null>(null)
  const editorRef = useRef<Editor | null>(null)
  const types = useMemo(
    () =>
      blockTypes(messages.blocks, uploadImage ? { pickImage: () => picker.current?.click() } : {}),
    [messages.blocks, uploadImage]
  )

  /** Adds images where `at` is, else where the selection is, each as a figure of its own. */
  const addImages = async (files: readonly File[], at?: number) => {
    const editor = editorRef.current
    if (!editor || !uploadImage) return
    let pos = at ?? editor.state.selection.to
    for (const file of files) {
      try {
        const { src, alt } = await uploadImage(file)
        const figure = { type: "image", attrs: { src, alt, title: null } }
        editor.chain().insertContentAt(pos, figure).focus().run()
        pos = editor.state.selection.to
      } catch (error) {
        toast.error(error instanceof Error && error.message ? error.message : messages.imageFailed)
      }
    }
  }
  const slash = useMemo(() => new SlashMenuStore(), [])
  const [linkRequest, setLinkRequest] = useState(0)

  const editor = useEditor(
    {
      editable,
      extensions: [
        ...documentSchemaExtensions({
          callout: CalloutNode.extend({
            addNodeView: () => ReactNodeViewRenderer(CalloutView),
          }),
        }).map((extension) =>
          extension.name === "image"
            ? Figure.extend({ addNodeView: () => ReactNodeViewRenderer(FigureView) })
            : extension
        ),
        Collaboration.configure({ fragment }),
        CollaborationCaret.configure({
          provider: { awareness },
          // Who someone is, the server says: what this reader says of itself is replaced.
          user: {},
          render: caret,
          selectionRender: (user: { readonly color?: string }) => ({
            nodeName: "span",
            class: "sixb-caret-selection",
            style: `--caret: ${user.color ?? "#888"}`,
          }),
        }),
        Placeholder.configure({
          includeChildren: true,
          showOnlyCurrent: true,
          placeholder: ({ editor, node, pos }) => placeholder(editor, node, pos, messages),
        }),
        SlashCommand(slash, () => types),
        BlockShortcuts.configure({ onLink: () => setLinkRequest((count) => count + 1) }),
      ],
      editorProps: {
        attributes: {
          class: "prose sixb-document sixb-editor",
          spellcheck: "true",
          "aria-multiline": "true",
          role: "textbox",
        },
        // An image dropped or pasted is added where it lands.
        handleDrop: (view, event, _slice, moved) => {
          const files = imagesOf(event.dataTransfer)
          if (moved || files.length === 0 || !uploadImage) return false
          event.preventDefault()
          const at = view.posAtCoords({ left: event.clientX, top: event.clientY })
          void addImages(files, at?.pos)
          return true
        },
        // Markdown pasted as text becomes its blocks; copied, blocks are Markdown again.
        handlePaste: (view, event) => {
          const files = imagesOf(event.clipboardData)
          if (files.length > 0 && uploadImage) {
            void addImages(files)
            return true
          }
          const text = event.clipboardData?.getData("text/plain") ?? ""
          if (event.clipboardData?.getData("text/html") || !looksLikeMarkdown(text)) return false
          const content = markdownToBlocks(text).content ?? []
          const editorOf = (view as unknown as { editor?: Editor }).editor
          if (!editorOf) return false
          return editorOf.commands.insertContent(content as never)
        },
        clipboardTextSerializer: (slice) => {
          const json = slice.content.toJSON() as { readonly type: string }[] | null
          if (!json?.length) return ""
          const blocks = json[0]?.type === "text" ? [{ type: "paragraph", content: json }] : json
          try {
            return blocksToMarkdown({ type: "doc", content: blocks as never }).trimEnd()
          } catch {
            return slice.content.textBetween(0, slice.content.size, "\n\n")
          }
        },
      },
    },
    [fragment, awareness, types]
  )
  editorRef.current = editor

  if (editor && editor.isEditable !== editable) editor.setEditable(editable)

  return (
    <FigureContext.Provider value={{ source: imageSource, caption: messages.caption }}>
      <div
        data-sixb-artifact=""
        className={cn(
          "@container min-h-0 flex-1 overflow-y-auto bg-background text-foreground",
          theme?.className
        )}
        style={theme?.style}
      >
        <div className="sixb-document-page">
          <article className="relative">
            <EditorContent editor={editor} />
            {editor && editable ? (
              <>
                <BlockHandle editor={editor} types={types} messages={messages} />
                <SelectionToolbar
                  editor={editor}
                  types={types}
                  messages={messages}
                  linkRequest={linkRequest}
                />
              </>
            ) : null}
          </article>
        </div>
      </div>
      <SlashMenu store={slash} messages={messages} />
      {uploadImage ? (
        <input
          ref={picker}
          type="file"
          accept="image/*"
          multiple
          hidden
          onChange={(event) => {
            const files = [...(event.target.files ?? [])]
            event.target.value = ""
            void addImages(files)
          }}
        />
      ) : null}
    </FigureContext.Provider>
  )
}

/** The images among the files a drop or a paste carries. */
function imagesOf(data: DataTransfer | null | undefined): File[] {
  return [...(data?.files ?? [])].filter((file) => file.type.startsWith("image/"))
}

/** Another editor's caret: a line in their color, their name above it. */
function caret(user: { readonly name?: string; readonly color?: string }): HTMLElement {
  const element = document.createElement("span")
  element.className = "sixb-caret"
  element.style.setProperty("--caret", user.color ?? "#888")
  const label = document.createElement("span")
  label.className = "sixb-caret-label"
  label.textContent = user.name || "·"
  element.append(label)
  return element
}

/** What an empty block says it is for, while the caret is in it. */
function placeholder(
  editor: Editor,
  node: ProseMirrorNode,
  pos: number,
  messages: EditorMessages
): string {
  if (node.type.name === "heading") {
    return pos === 0 ? messages.titlePlaceholder : messages.heading(Number(node.attrs.level))
  }
  if (node.type.name !== "paragraph") return ""
  const parent = editor.state.doc.resolve(pos).parent.type.name
  if (parent === "listItem") return messages.listItem
  if (parent === "taskItem") return messages.taskItem
  if (pos === 0 && editor.state.doc.childCount === 1) return messages.titlePlaceholder
  return messages.placeholder
}

/** Whether pasted text reads as Markdown: a heading, a list, a quote, a fence, a table, a link. */
function looksLikeMarkdown(text: string): boolean {
  return (
    /^(#{1,6} |[-*+] |\d+\. |> |```|\|.+\|$|- \[[ x]\] )/m.test(text) ||
    /\*\*[^*\n]+\*\*|\[[^\]\n]+\]\([^)\n]+\)/.test(text)
  )
}

/**
 * Keys for whole blocks: ⌘D duplicates the one the caret is in, ⌥⇧↑ and ⌥⇧↓ move it, ⌘K opens
 * the link field over the selection.
 */
const BlockShortcuts = Extension.create<{ readonly onLink: () => void }>({
  name: "blockShortcuts",
  addOptions: () => ({ onLink: () => {} }),
  addKeyboardShortcuts() {
    const current = () => {
      const { $from } = this.editor.state.selection
      if ($from.depth < 1) return null
      const pos = $from.before(1)
      const node = this.editor.state.doc.nodeAt(pos)
      return node ? { node, pos } : null
    }
    const move = (by: -1 | 1) => {
      const at = current()
      if (!at) return false
      const index = this.editor.state.doc.resolve(at.pos).index()
      const sibling = this.editor.state.doc.maybeChild(index + by)
      if (!sibling) return true
      const offset = this.editor.state.selection.from - at.pos
      const target = by === 1 ? at.pos + sibling.nodeSize : at.pos - sibling.nodeSize
      return this.editor
        .chain()
        .command(({ tr }) => {
          tr.delete(at.pos, at.pos + at.node.nodeSize)
          tr.insert(target, at.node)
          return true
        })
        .setTextSelection(target + offset)
        .scrollIntoView()
        .run()
    }
    return {
      "Mod-d": () => {
        const at = current()
        if (!at) return false
        return this.editor
          .chain()
          .insertContentAt(at.pos + at.node.nodeSize, at.node.toJSON())
          .run()
      },
      "Alt-Shift-ArrowUp": () => move(-1),
      "Alt-Shift-ArrowDown": () => move(1),
      "Mod-k": () => {
        if (this.editor.state.selection.empty) return false
        this.options.onLink()
        return true
      },
    }
  },
})
