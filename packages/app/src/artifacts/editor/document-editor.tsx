import { createHeadingSlugger, isArtifactAddress } from "@sixb/core/artifacts"
import { blocksToMarkdown, LIVE_FILES, markdownToBlocks } from "@sixb/core/artifacts/live"
import { toast } from "@sixb/ui/components"
import { cn } from "@sixb/ui/lib/utils"
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react"
import type { Awareness } from "y-protocols/awareness"
import type * as Y from "yjs"
import { BlockHandle } from "./block-handle"
import { blockTypes } from "./blocks"
import { CalloutView } from "./callout-view"
import { insertContentAt } from "./core/commands"
import { Editor, type EditorPlugin } from "./core/editor"
import { Fragment, type Node, Slice } from "./core/model"
import { baseKeymap, caretsPlugin, historyPlugin, placeholderPlugin } from "./core/plugins"
import { type EditorState, TextSelection as import_TextSelection } from "./core/state"
import { documentPlugins, softBreaks } from "./document-plugins"
import { FigureContext, FigureView } from "./figure-view"
import type { EditorMessages } from "./messages"
import {
  NodeViewPortals,
  NodeViewPortalsHost,
  reactNodeView,
  tableView,
  taskItemView,
} from "./node-views"
import { documentSchema } from "./schema"
import { SelectionToolbar } from "./selection-toolbar"
import { SlashMenu, SlashMenuStore, slashCommand } from "./slash-menu"

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
  /** The section to open at: the slug of its heading, as the document page names it. */
  readonly part?: string
}

export function DocumentEditor({
  fragment,
  awareness,
  editable,
  imageSource,
  messages,
  theme,
  uploadImage,
  part,
}: DocumentEditorProps) {
  const picker = useRef<HTMLInputElement | null>(null)
  const host = useRef<HTMLDivElement | null>(null)
  const [editor, setEditor] = useState<Editor | null>(null)
  const editorRef = useRef<Editor | null>(null)
  const types = useMemo(
    () =>
      blockTypes(messages.blocks, uploadImage ? { pickImage: () => picker.current?.click() } : {}),
    [messages.blocks, uploadImage]
  )
  const slash = useMemo(() => new SlashMenuStore(), [])
  const portals = useMemo(() => new NodeViewPortals(), [])
  const [linkRequest, setLinkRequest] = useState(0)
  const editableRef = useRef(editable)
  editableRef.current = editable

  /** Adds images where `at` is, else where the selection is, each as a figure of its own. */
  const addImages = async (files: readonly File[], at?: number) => {
    const current = editorRef.current
    if (!current || !uploadImage) return
    // Where they go moves with what anyone changes while they upload.
    let pos = at ?? current.state.selection.to
    const off = current.on("transaction", ({ transaction }) => {
      if (transaction) pos = transaction.mapping.map(pos)
    })
    try {
      for (const file of files) {
        try {
          const { src, alt } = await uploadImage(file)
          const figure = documentSchema.nodeType("image").create({ src, alt, title: null })
          current.run(insertContentAt(Math.min(pos, current.state.doc.content.size), figure))
          current.focus()
          pos = current.state.selection.to
        } catch (error) {
          toast.error(
            error instanceof Error && error.message ? error.message : messages.imageFailed
          )
        }
      }
    } finally {
      off()
    }
  }
  const addImagesRef = useRef(addImages)
  addImagesRef.current = addImages

  // A picture publishing takes: another artifact's, or one of this artifact's files.
  const isOwnImage = (src: string) => {
    const files = fragment.doc?.getMap<unknown>(LIVE_FILES)
    if (isArtifactAddress(src)) return true
    const path = artifactPath(src)
    return path !== null && files?.has(path) === true
  }
  const isOwnImageRef = useRef(isOwnImage)
  isOwnImageRef.current = isOwnImage
  const uploads = !!uploadImage

  useLayoutEffect(() => {
    const mount = document.createElement("div")
    host.current?.append(mount)
    let made: Editor | null = null
    const current = () => made
    // What the editor's own props did before any plugin: pictures dropped and pasted, Markdown
    // pasted as text, and copying as Markdown.
    const props: EditorPlugin = {
      handleDrop: (view, event, _slice, moved) => {
        const files = imagesOf(event.dataTransfer)
        if (moved || files.length === 0 || !uploads) return false
        event.preventDefault()
        const at = view.posAtCoords({ left: event.clientX, top: event.clientY })
        void addImagesRef.current(files, at?.pos)
        return true
      },
      // What is pasted or dropped from elsewhere keeps only the artifact's own pictures: the
      // document could not be saved with any other.
      transformPasted: (slice) => {
        const content = withOwnImages(slice.content, isOwnImageRef.current)
        if (content === slice.content) return slice
        const open = Slice.maxOpen(content)
        return new Slice(
          content,
          Math.min(slice.openStart, open.openStart),
          Math.min(slice.openEnd, open.openEnd)
        )
      },
      // Markdown pasted as text becomes its blocks; copied, blocks are Markdown again.
      handlePaste: (view, event) => {
        const files = imagesOf(event.clipboardData)
        if (files.length > 0 && uploads) {
          void addImagesRef.current(files)
          return true
        }
        const text = event.clipboardData?.getData("text/plain") ?? ""
        if (event.clipboardData?.getData("text/html") || !looksLikeMarkdown(text)) return false
        // Code is pasted as it is.
        if (view.state.selection.$from.parent.type.spec.code) return false
        const content = markdownToBlocks(text).content ?? []
        // Words alone go into the line they are pasted in; blocks, as blocks.
        const [only] = content
        const inline = content.length === 1 && only?.type === "paragraph"
        // Markdown trims a paragraph's spaces; words pasted into a line keep theirs.
        const space = (match: RegExpMatchArray | null) =>
          match ? [{ type: "text", text: match[0] }] : []
        const nodes = inline
          ? [
              ...space(text.match(/^[ \t]+/)),
              ...(only.content ?? []),
              ...space(text.match(/[ \t]+$/)),
            ]
          : content
        try {
          const parsed = Fragment.fromArray(
            nodes.map((node) => documentSchema.nodeFromJSON(node as never))
          )
          const fragmentOwn = withOwnImages(parsed, isOwnImageRef.current)
          view.dispatch(view.state.tr.replaceSelection(Slice.maxOpen(fragmentOwn)).scrollIntoView())
          return true
        } catch {
          return false
        }
      },
      clipboardTextSerializer: (slice) => {
        const plain = () => slice.content.textBetween(0, slice.content.size, "\n\n", "\n")
        const json = slice.content.toJSON()
        if (!json.length) return ""
        const inline = slice.content.firstChild?.isInline === true
        const blocks = inline ? [{ type: "paragraph", content: json }] : json
        try {
          // A slice of list items or cells writes nothing as Markdown alone: its words, then.
          return blocksToMarkdown({ type: "doc", content: blocks as never }).trimEnd() || plain()
        } catch {
          return plain()
        }
      },
    }
    made = new Editor({
      mount,
      fragment,
      schema: documentSchema,
      editable: editableRef.current,
      awareness,
      attributes: {
        class: "prose sixb-document sixb-editor",
        spellcheck: "true",
        "aria-multiline": "true",
        role: "textbox",
      },
      nodeViews: {
        callout: reactNodeView(portals, CalloutView),
        image: reactNodeView(portals, FigureView),
        taskItem: taskItemView,
        table: tableView,
      },
      plugins: [
        props,
        ...documentPlugins({
          history: historyPlugin(() => current() as Editor),
          before: [
            softBreaks,
            blockShortcuts(() => setLinkRequest((count) => count + 1)),
            slashCommand(slash, () => types, current),
            placeholderPlugin(
              (node, pos, state) => placeholder(state, node, pos, messages),
              () => current()?.isEditable ?? false
            ),
            caretsPlugin(awareness, {
              render: caret,
              selection: (user) => ({
                nodeName: "span",
                class: "sixb-caret-selection",
                style: `--caret: ${user.color ?? "#888"}`,
              }),
            }),
          ],
          base: (rules) => baseKeymap(rules),
        }),
      ],
    })
    editorRef.current = made
    setEditor(made)
    return () => {
      made?.destroy()
      mount.remove()
      editorRef.current = null
      setEditor(null)
    }
  }, [fragment, awareness, types, portals, slash, messages, uploads])

  useEffect(() => {
    if (editor && editor.isEditable !== editable) editor.setEditable(editable)
  }, [editor, editable])

  // A link to one of its sections opens there, as the document page does.
  useEffect(() => {
    if (!editor || !part) return
    const slug = createHeadingSlugger()
    let found: number | null = null
    editor.state.doc.forEach((node, pos) => {
      if (found !== null || node.type.name !== "heading") return
      if (slug(node.textContent.replace(/\s+/g, " ").trim()) === part) found = pos
    })
    if (found === null) return
    const dom = editor.view.nodeDOM(found)
    if (dom instanceof HTMLElement) dom.scrollIntoView({ block: "start" })
  }, [editor, part])

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
            <div ref={host} />
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
      <NodeViewPortalsHost portals={portals} />
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

/**
 * `content` without the pictures `own` does not take, nor the Markdown kept as written that shows
 * one; the same fragment when it holds none. A block of blocks they leave empty gets what it must
 * hold.
 */
function withOwnImages(content: Fragment, own: (src: string) => boolean): Fragment {
  let changed = false
  const kept: Node[] = []
  content.forEach((node) => {
    const shown =
      node.type.name === "image"
        ? [String(node.attrs.src ?? "")]
        : node.type.name === "markdown" || node.type.name === "markdownInline"
          ? imageSources(String(node.attrs.source ?? ""))
          : []
    if (!shown.every(own)) {
      changed = true
      return
    }

    const inner = node.isLeaf ? node.content : withOwnImages(node.content, own)
    if (inner === node.content) {
      kept.push(node)
      return
    }
    changed = true
    // Words that were pictures alone go with them.
    if (node.isTextblock && inner.size === 0) return
    const rebuilt = node.type.createAndFill(node.attrs, inner, node.marks)
    if (rebuilt) kept.push(rebuilt)
  })
  return changed ? Fragment.from(kept) : content
}

/** The pictures Markdown or HTML written as it was shows: `![…](src)` and `<img src>`. */
function imageSources(source: string): string[] {
  const pictures = source.matchAll(
    /!\[[^\]]*\]\(\s*<?([^\s)>]*)|<img\b[^>]*?\bsrc\s*=\s*["']?([^"'\s>]*)/gi
  )
  return [...pictures].map((match) => match[1] ?? match[2] ?? "")
}

/**
 * The file of the artifact a picture's path names, as publishing reads it; null for a path that
 * cannot name one: an address elsewhere, a `data:` image, or a path from the root.
 */
function artifactPath(src: string): string | null {
  if (src === "" || src.startsWith("/") || /^[a-z][a-z\d+.-]*:/i.test(src)) return null
  let path = src.split(/[?#]/)[0] ?? ""
  try {
    path = decodeURI(path)
  } catch {
    // Kept as written: it simply names no file.
  }
  const segments: string[] = []
  for (const segment of path.split("/")) {
    if (segment === "..") segments.pop()
    else if (segment !== "" && segment !== ".") segments.push(segment)
  }
  return segments.join("/")
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
  state: EditorState,
  node: Node,
  pos: number,
  messages: EditorMessages
): string {
  if (node.type.name === "heading") {
    return pos === 0 ? messages.titlePlaceholder : messages.heading(Number(node.attrs.level))
  }
  if (node.type.name !== "paragraph") return ""
  const parent = state.doc.resolve(pos).parent.type.name
  if (parent === "listItem") return messages.listItem
  if (parent === "taskItem") return messages.taskItem
  if (pos === 0 && state.doc.childCount === 1) return messages.titlePlaceholder
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
function blockShortcuts(onLink: () => void): EditorPlugin {
  const current = (state: EditorState) => {
    const { $from } = state.selection
    if ($from.depth < 1) return null
    const pos = $from.before(1)
    const node = state.doc.nodeAt(pos)
    return node ? { node, pos } : null
  }
  const move = (view: import("./core/view").EditorView, by: -1 | 1) => {
    const at = current(view.state)
    if (!at) return false
    const index = view.state.doc.resolve(at.pos).index()
    const sibling = view.state.doc.maybeChild(index + by)
    if (!sibling) return true
    const offset = view.state.selection.from - at.pos
    const target = by === 1 ? at.pos + sibling.nodeSize : at.pos - sibling.nodeSize
    const tr = view.state.tr
    tr.delete(at.pos, at.pos + at.node.nodeSize)
    tr.insert(target, at.node)
    const caretAt = Math.min(Math.max(target + offset, 0), tr.doc.content.size)
    tr.setSelection(import_TextSelection.between(tr.doc.resolve(caretAt), tr.doc.resolve(caretAt)))
    view.dispatch(tr.scrollIntoView())
    return true
  }
  return {
    keys: {
      "Mod-d": (view) => {
        const at = current(view.state)
        if (!at) return false
        const tr = view.state.tr
        insertContentAt(at.pos + at.node.nodeSize, at.node)(tr)
        view.dispatch(tr)
        return true
      },
      "Alt-Shift-ArrowUp": (view) => move(view, -1),
      "Alt-Shift-ArrowDown": (view) => move(view, 1),
      "Mod-k": (view) => {
        if (view.state.selection.empty) return false
        onLink()
        return true
      },
    },
  }
}
