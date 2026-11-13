import { isPageEntry, LIVE_FILES, PAGE_BODY } from "@sixb/core/artifacts/live"
import { Editor, Extension } from "@tiptap/core"
import { Collaboration } from "@tiptap/extension-collaboration"
import { CollaborationCaret } from "@tiptap/extension-collaboration-caret"
import { Placeholder } from "@tiptap/extensions"
import type { Node as ProseMirrorNode } from "@tiptap/pm/model"
import { NodeSelection, Plugin, PluginKey, Selection, TextSelection } from "@tiptap/pm/state"
import type { Mappable } from "@tiptap/pm/transform"
import { Decoration, DecorationSet, type EditorView, type NodeView } from "@tiptap/pm/view"
import { exitSuggestion, Suggestion, type SuggestionProps } from "@tiptap/suggestion"
import { Awareness, applyAwarenessUpdate } from "y-protocols/awareness"
import * as Y from "yjs"
import { findBlockTypes } from "../editor/find-blocks"
import {
  blockAt,
  blockKind,
  caretInto,
  dropTarget,
  duplicate,
  insertBlock,
  move,
  moveTo,
  placeAfter,
  placeBlock,
  rectOf,
  remove,
  SINGLE_BLOCK_TAGS,
  tagOf,
  turnable,
  turnInto,
  withoutId,
  words,
  wordsAt,
} from "./commands"
import { PageKeys } from "./keys"
import type {
  AppToEditor,
  EditorCommand,
  EditorRect,
  EditorToApp,
  EditorWords,
  HoverState,
  PageBlockChoice,
  PageMark,
  SelectionState,
  SlashState,
} from "./protocol"
import {
  PageImage,
  pageSchemaExtensions,
  RawBlock,
  RawInline,
  sanitize,
  startTag,
  tagAttributes,
} from "./schema"
import { PAGE_EDITOR_CSS } from "./style"

// A designed document's editor, running in its frame on the page itself: the body is the editor,
// so the page's stylesheets style what is typed as they style the page. It edits a copy of the
// live document the app keeps in step through the port, and tells the app what to draw over the
// frame: the toolbar over selected words, the `/` menu, the handle beside the block the pointer
// is over, and where a dragged block would land. See ./protocol.ts.

/** The origin of what the app sends, which is never sent back. */
const FROM_APP = Symbol("app")

const slashKey = new PluginKey("sixb-page-slash")
const breaksKey = new PluginKey<DecorationSet>("sixb-page-breaks")

/** The tags of each mark the toolbar shows, the first the one it adds. */
const MARK_TAGS: Readonly<Record<PageMark, readonly string[]>> = {
  bold: ["strong", "b"],
  italic: ["em", "i"],
  underline: ["u"],
  strike: ["s", "del"],
  code: ["code"],
}

const PAGE_BREAKS = ["page", "left", "right", "recto", "verso"]

export function startFrameEditor({
  port,
  body,
}: {
  readonly port: MessagePort
  readonly body: HTMLElement
}): void {
  const post = (message: EditorToApp) => port.postMessage(message)
  const doc = new Y.Doc()
  const awareness = new Awareness(doc)
  /** Pictures the reader just added, shown from their bytes until a version holds them. */
  const previews = new Map<string, string>()
  let editor: Editor | null = null
  let blocks: readonly PageBlockChoice[] = []
  let slash: {
    items: PageBlockChoice[]
    index: number
    range: { from: number; to: number }
  } | null = null
  let pointer: { x: number; y: number } | null = null
  let dragging = false
  const last = { selection: "", slash: "", hover: "" }

  // Positions the app was told of, each mapped through every change since, so a command that
  // names one acts on the block it was told of: the menu, a drag or an upload takes a while, and
  // others type meanwhile. One whose block is gone names nothing.
  const told = new Map<number, number | null>()
  const tell = (pos: number | null): number | null => {
    if (pos === null) return null
    told.delete(pos)
    told.set(pos, pos)
    if (told.size > 64) told.delete(told.keys().next().value as number)
    return pos
  }
  const mapTold = (mapping: Mappable) => {
    for (const [reported, current] of told) {
      if (current === null) continue
      const mapped = mapping.mapResult(current, 1)
      told.set(reported, mapped.deletedAfter ? null : mapped.pos)
    }
  }
  /** Where the block the app names by `pos` is now; null when it is gone. */
  const now = (pos: number): number | null => (told.has(pos) ? (told.get(pos) ?? null) : pos)

  const send = <Key extends keyof typeof last>(key: Key, value: unknown, message: EditorToApp) => {
    const json = JSON.stringify(value)
    if (last[key] === json) return
    last[key] = json
    post(message)
  }

  // ── What the app draws over the frame ─────────────────────────────────

  let scheduled = 0
  const schedule = () => {
    if (scheduled) return
    scheduled = requestAnimationFrame(() => {
      scheduled = 0
      report()
    })
  }

  const report = () => {
    if (!editor) return
    const selection = selectionState(editor)
    send("selection", selection, { type: "selection", selection })
    const menu: SlashState | null =
      slash && editor.isEditable
        ? {
            rect: caretRect(editor.view, slash.range.from),
            items: slash.items.map((item) => item.id),
            index: slash.index,
          }
        : null
    send("slash", menu, { type: "slash", slash: menu })
    if (!dragging) {
      const hover = hoverState(editor)
      if (hover) tell(hover.pos)
      send("hover", hover, { type: "hover", hover })
    }
  }

  const hoverState = (current: Editor): HoverState | null => {
    if (!pointer || !current.isEditable) return null
    const target = blockAt(current.view, pointer.x, pointer.y)
    const rect = target ? rectOf(current.view.nodeDOM(target.pos)) : null
    if (!target || !rect) return null
    return { pos: target.pos, rect, textual: turnable(current.state.doc, target.pos) }
  }

  document.addEventListener("mousemove", (event) => {
    pointer = { x: event.clientX, y: event.clientY }
    schedule()
  })
  document.documentElement.addEventListener("mouseleave", () => {
    pointer = null
    schedule()
  })
  window.addEventListener("scroll", schedule, { passive: true })
  window.addEventListener("resize", schedule)

  // ── The `/` menu ──────────────────────────────────────────────────────

  const openMenu = (props: SuggestionProps<PageBlockChoice>) => {
    const keep = slash !== null && slash.items.length === props.items.length
    slash = {
      items: props.items,
      index: keep && slash ? Math.min(slash.index, Math.max(0, props.items.length - 1)) : 0,
      range: props.range,
    }
    schedule()
  }

  const choose = (index: number) => {
    const current = editor
    const item = slash?.items[index]
    const range = slash?.range
    if (!current || !item || !range) return
    slash = null
    if (item.id === "image") {
      current.chain().focus().deleteRange(range).run()
      post({ type: "pickImage", at: tell(wordsAt(current.state.selection)?.pos ?? null) })
      return
    }
    insertBlock(current, item.id, range)
  }

  const SlashMenu = Extension.create({
    name: "pageSlash",
    addProseMirrorPlugins() {
      return [
        Suggestion<PageBlockChoice>({
          editor: this.editor,
          pluginKey: slashKey,
          char: "/",
          // Not in `<pre>`, where `/` is a character like any other.
          allow: ({ state, range }) => {
            const parent = state.doc.resolve(range.from).parent
            return parent.type.name === "textBlock" && tagOf(parent) !== "pre"
          },
          items: ({ query }) => findBlockTypes(blocks, query),
          command: () => {},
          render: () => ({
            onStart: openMenu,
            onUpdate: openMenu,
            onKeyDown: ({ event }) => {
              if (!slash) return false
              const count = slash.items.length
              if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                if (count > 0) {
                  const by = event.key === "ArrowDown" ? 1 : -1
                  slash.index = (slash.index + by + count) % count
                  schedule()
                }
                return true
              }
              if (event.key === "Enter" || event.key === "Tab") {
                if (count === 0) return false
                choose(slash.index)
                return true
              }
              return false
            },
            onExit: () => {
              slash = null
              schedule()
            },
          }),
        }),
      ]
    },
  })

  // ── Page breaks, as the sheet shows them ──────────────────────────────

  let pageBreakLabel = ""
  const PageBreaks = Extension.create({
    name: "pageBreaks",
    addProseMirrorPlugins() {
      return [
        new Plugin<DecorationSet>({
          key: breaksKey,
          state: {
            init: () => DecorationSet.empty,
            apply: (tr, set) =>
              (tr.getMeta(breaksKey) as DecorationSet | undefined) ?? set.map(tr.mapping, tr.doc),
          },
          props: { decorations: (state) => breaksKey.getState(state) },
          view: (view) => {
            let timer: ReturnType<typeof setTimeout> | undefined
            let shown = ""
            const measure = () => {
              const at = pageBreaks(view)
              const key = at.join(",")
              if (key === shown) return
              shown = key
              const set = DecorationSet.create(
                view.state.doc,
                at.map((pos) =>
                  Decoration.widget(pos, () => pageBreak(pageBreakLabel), {
                    side: -1,
                    ignoreSelection: true,
                    key: `break-${pos}`,
                  })
                )
              )
              view.dispatch(view.state.tr.setMeta(breaksKey, set).setMeta("addToHistory", false))
            }
            const later = () => {
              clearTimeout(timer)
              timer = setTimeout(measure, 120)
            }
            later()
            document.fonts?.ready.then(later)
            // Where the page breaks moves with its blocks and its width, never with the caret.
            window.addEventListener("resize", later)
            return {
              update: (_view, previous) => {
                if (view.state.doc !== previous.doc) later()
              },
              destroy: () => {
                clearTimeout(timer)
                window.removeEventListener("resize", later)
              },
            }
          },
        }),
      ]
    },
  })

  // ── Marks and links ───────────────────────────────────────────────────

  const toggleMark = (current: Editor, mark: PageMark) => {
    const tags = MARK_TAGS[mark]
    const chain = current.chain().focus()
    if (tags.some((tag) => current.isActive(tag))) {
      for (const tag of tags) chain.unsetMark(tag)
    } else {
      const tag = tags[0] as string
      chain.setMark(tag, { open: `<${tag}>`, close: `</${tag}>` })
    }
    chain.run()
  }

  const setLink = (current: Editor, href: string | null) => {
    const chain = current.chain().focus().extendMarkRange("a")
    if (href === null) {
      chain.unsetMark("a").run()
      return
    }
    // A link keeps whatever else its tag says, its class among them.
    const attrs = { ...tagAttributes(current.getAttributes("a").open as string | undefined), href }
    chain.setMark("a", { open: startTag("a", attrs), close: "</a>" }).run()
  }

  // ── What the app asks ─────────────────────────────────────────────────

  const run = (current: Editor, given: EditorCommand) => {
    const { state } = current
    let command = given
    if ("pos" in command && command.pos !== undefined) {
      const pos = now(command.pos)
      // The block it named is gone, or no longer starts there: it does nothing.
      if (pos === null || !state.doc.nodeAt(pos)?.isBlock) {
        if (command.name === "drag" || command.name === "drop") post({ type: "drop", line: null })
        return
      }
      command = { ...command, pos }
    }
    if (command.name === "image" && command.at !== undefined) {
      const { at: told, ...rest } = command
      const at = now(told)
      command = at === null ? rest : { ...rest, at }
    }
    switch (command.name) {
      case "mark":
        return toggleMark(current, command.mark)
      case "link":
        return setLink(current, command.href)
      case "turnInto":
        return void turnInto(current, command.block, command.pos)
      case "choose":
        return choose(command.index)
      case "point":
        if (slash) slash.index = command.index
        return schedule()
      case "closeMenu":
        return exitSuggestion(current.view, slashKey)
      case "addBelow": {
        const node = state.doc.nodeAt(command.pos)
        if (!node) return
        const tr = state.tr
        let at = command.pos
        if (node.type.name === "textBlock" && tagOf(node) === "li") {
          at = command.pos + node.nodeSize
          const open =
            typeof node.attrs.open === "string" ? withoutId(node.attrs.open, "li") : undefined
          tr.insert(at, words(current.schema, "li", open))
        } else if (
          node.type.name !== "textBlock" ||
          node.content.size > 0 ||
          SINGLE_BLOCK_TAGS.has(tagOf(node))
        ) {
          at = placeAfter(state.doc, command.pos)
          tr.insert(at, words(current.schema, "p"))
        }
        tr.setSelection(TextSelection.create(tr.doc, at + 1)).insertText("/")
        current.view.dispatch(tr.scrollIntoView())
        current.view.focus()
        return
      }
      case "duplicate":
        return void duplicate(current, command.pos)
      case "remove":
        return void remove(current, command.pos)
      case "move":
        return void move(current, command.pos, command.by)
      case "pick": {
        if (!state.doc.nodeAt(command.pos)) return
        // Not focused: the app's menu for it keeps the focus while it is open.
        current.view.dispatch(state.tr.setSelection(NodeSelection.create(state.doc, command.pos)))
        return
      }
      case "drag": {
        dragging = true
        const target = dropTarget(current.view, command.pos, command.x, command.y)
        post({ type: "drop", line: target?.line ?? null })
        // Near the frame's top or bottom edge, the page scrolls to where the block is going.
        const edge = 56
        if (command.y < edge) window.scrollBy(0, -Math.ceil((edge - command.y) / 3))
        else if (command.y > window.innerHeight - edge) {
          window.scrollBy(0, Math.ceil((command.y - window.innerHeight + edge) / 3))
        }
        return
      }
      case "drop": {
        const target = dropTarget(current.view, command.pos, command.x, command.y)
        if (target) moveTo(current, command.pos, target.at)
        dragging = false
        post({ type: "drop", line: null })
        return schedule()
      }
      case "endDrag":
        dragging = false
        post({ type: "drop", line: null })
        return schedule()
      case "image": {
        if (command.preview) previews.set(command.src, URL.createObjectURL(command.preview))
        const image = current.schema.nodes.image.create({
          source: startTag("img", { src: command.src, alt: command.alt }),
        })
        const tr = state.tr
        const target = command.at ?? wordsAt(state.selection)?.pos
        let placed = tr.doc.content.size
        if (target === undefined || target === null || !tr.doc.nodeAt(target)) {
          tr.insert(placed, image)
        } else {
          placed = placeBlock(tr, target, image)
        }
        caretInto(tr, placed)
        current.view.dispatch(tr.scrollIntoView())
        current.view.focus()
        return
      }
      case "focus":
        current.commands.focus()
        return
    }
  }

  // ── The editor ────────────────────────────────────────────────────────

  const mount = (fragment: Y.XmlFragment, editable: boolean, text: EditorWords) => {
    pageBreakLabel = text.pageBreak
    const style = document.createElement("style")
    style.id = "sixb-page-editor"
    style.textContent = PAGE_EDITOR_CSS
    document.head.append(style)

    // The page the frame loaded gives way to the live one, which the editor draws.
    const bodyClass = body.getAttribute("class")
    body.replaceChildren()
    const extensions = pageSchemaExtensions().map((extension) => {
      if (extension.name === RawBlock.name) {
        return RawBlock.extend({
          addNodeView:
            () =>
            ({ node }) =>
              rawView(node, false),
        })
      }
      if (extension.name === RawInline.name) {
        return RawInline.extend({
          addNodeView:
            () =>
            ({ node }) =>
              rawView(node, true),
        })
      }
      if (extension.name === PageImage.name) {
        return PageImage.extend({
          addNodeView:
            () =>
            ({ node }) =>
              imageView(node, previews),
        })
      }
      return extension
    })

    const current = new Editor({
      element: { mount: body },
      injectCSS: false,
      editable,
      extensions: [
        ...extensions,
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
          placeholder: ({ node }) => placeholder(node, text),
        }),
        PageKeys.configure({ toggleMark, onLink: () => post({ type: "linkRequest" }) }),
        SlashMenu,
        PageBreaks,
      ],
      editorProps: {
        attributes: bodyClass ? { class: bodyClass } : {},
        // A link is for reading: in the editor, a click puts the caret in its words.
        handleDOMEvents: {
          click: (_view, event) => {
            if ((event.target as Element | null)?.closest?.("a[href]")) event.preventDefault()
            return false
          },
        },
        handlePaste: (view, event) => {
          const files = imagesOf(event.clipboardData)
          if (files.length === 0) return false
          post({ type: "upload", files, at: tell(wordsAt(view.state.selection)?.pos ?? null) })
          return true
        },
        handleDrop: (view, event, _slice, moved) => {
          const files = imagesOf(event.dataTransfer)
          if (moved || files.length === 0) return false
          event.preventDefault()
          const at = blockAt(view, event.clientX, event.clientY)
          post({ type: "upload", files, at: tell(at?.pos ?? null) })
          return true
        },
        // What is pasted from elsewhere brings its words and structure, not its styles.
        transformPastedHTML: (html) => (html.includes("data-pm-slice") ? html : plainHtml(html)),
      },
      // The live blocks replace the empty page the editor starts with, and the caret it had there
      // lands in a box: it starts at the first words instead.
      onCreate: ({ editor: created }) => {
        const start = Selection.atStart(created.state.doc)
        created.view.dispatch(created.state.tr.setSelection(start).setMeta("addToHistory", false))
      },
      onTransaction: ({ transaction }) => {
        if (transaction.docChanged) mapTold(transaction.mapping)
        schedule()
      },
      onSelectionUpdate: schedule,
      onFocus: () => {
        post({ type: "focus", focused: true })
        schedule()
      },
      onBlur: () => post({ type: "focus", focused: false }),
    })
    editor = current
    schedule()
  }

  port.onmessage = (event: MessageEvent<AppToEditor>) => {
    const message = event.data
    switch (message.type) {
      case "start": {
        Y.applyUpdate(doc, message.state, FROM_APP)
        blocks = message.blocks
        const files = doc.getMap<unknown>(LIVE_FILES)
        const entry = files.get(message.path)
        if (!isPageEntry(entry)) {
          post({ type: "gone" })
          return
        }
        doc.on("update", (update: Uint8Array, origin: unknown) => {
          if (origin !== FROM_APP) post({ type: "update", update })
        })
        files.observe((change) => {
          if (!change.keysChanged.has(message.path) || files.get(message.path) === entry) return
          editor?.setEditable(false)
          post({ type: "gone" })
        })
        awareness.on("update", (_changes: unknown, origin: unknown) => {
          if (origin === FROM_APP) return
          post({ type: "cursor", cursor: awareness.getLocalState()?.cursor ?? null })
        })
        mount(entry.get(PAGE_BODY) as Y.XmlFragment, message.editable, message.words)
        return
      }
      case "update":
        Y.applyUpdate(doc, message.update, FROM_APP)
        return
      case "awareness":
        applyAwarenessUpdate(awareness, message.update, FROM_APP)
        return
      case "editable":
        editor?.setEditable(message.editable)
        schedule()
        return
      case "run":
        if (editor) run(editor, message.command)
        return
    }
  }
  post({ type: "ready" })
}

/** The toolbar's state for selected words; null for none, or for a block picked whole. */
function selectionState(editor: Editor): SelectionState | null {
  const { selection } = editor.state
  if (!editor.isEditable || !(selection instanceof TextSelection) || selection.empty) return null
  const parent = selection.$from.parent
  if (parent.type.name !== "textBlock" || tagOf(parent) === "pre") return null
  const view = editor.view
  const start = view.coordsAtPos(selection.from)
  const end = view.coordsAtPos(selection.to)
  const block = rectOf(view.nodeDOM(selection.$from.before()))
  const oneLine = Math.abs(start.top - end.top) < 2
  const rect: EditorRect = {
    left: oneLine ? Math.min(start.left, end.left) : (block?.left ?? start.left),
    right: oneLine ? Math.max(start.right, end.right) : (block?.right ?? end.right),
    top: Math.min(start.top, end.top),
    bottom: Math.max(start.bottom, end.bottom),
  }
  const active = (tags: readonly string[]) => tags.some((tag) => editor.isActive(tag))
  const link = editor.isActive("a")
    ? (tagAttributes(editor.getAttributes("a").open as string | undefined).href ?? "")
    : null
  return {
    rect,
    marks: {
      bold: active(MARK_TAGS.bold),
      italic: active(MARK_TAGS.italic),
      underline: active(MARK_TAGS.underline),
      strike: active(MARK_TAGS.strike),
      code: active(MARK_TAGS.code),
    },
    link,
    block: blockKind(selection.$from),
    turnable: turnable(editor.state.doc, selection.$from.before()),
  }
}

function caretRect(view: EditorView, pos: number): EditorRect {
  const at = view.coordsAtPos(pos)
  return { left: at.left, top: at.top, right: at.right, bottom: at.bottom }
}

/**
 * Where the page breaks, as the frame's runtime marks them on one sheet: before a block whose
 * style breaks the page before it, after one whose style breaks it after, never in a flex or grid
 * layout, nor before what starts the sheet.
 */
function pageBreaks(view: EditorView): number[] {
  const found = new Set<number>()
  const top =
    view.dom.getBoundingClientRect().top +
    Number.parseFloat(getComputedStyle(view.dom).paddingTop || "0")
  view.state.doc.descendants((node, pos) => {
    if (!node.isBlock) return false
    const dom = view.nodeDOM(pos)
    if (!(dom instanceof HTMLElement)) return false
    const parent = dom.parentElement
    if (parent && /flex|grid/.test(getComputedStyle(parent).display)) return false
    const style = getComputedStyle(dom)
    if (PAGE_BREAKS.includes(style.breakBefore) && dom.getBoundingClientRect().top > top + 1) {
      found.add(pos)
    }
    if (PAGE_BREAKS.includes(style.breakAfter)) found.add(pos + node.nodeSize)
    return node.type.name === "box"
  })
  return [...found].sort((left, right) => left - right)
}

function pageBreak(label: string): HTMLElement {
  const element = document.createElement("div")
  element.className = "sixb-page-break"
  element.contentEditable = "false"
  element.setAttribute("aria-hidden", "true")
  element.setAttribute("data-label", label)
  return element
}

/** Markup kept as it was written, drawn from its source; nothing in it takes typing. */
function rawView(node: ProseMirrorNode, inline: boolean): NodeView {
  const template = document.createElement("template")
  template.innerHTML = String(node.attrs.source ?? "")
  sanitize(template.content)
  const nodes = Array.from(template.content.childNodes)
  const only = nodes.length === 1 && nodes[0] instanceof HTMLElement ? nodes[0] : null
  const dom = only ?? document.createElement(inline ? "span" : "div")
  if (!only) {
    dom.style.display = "contents"
    dom.append(...nodes)
  }
  dom.setAttribute("data-sixb-raw", "")
  dom.contentEditable = "false"
  return {
    dom,
    ignoreMutation: () => true,
    update: (next) => next.type === node.type && next.attrs.source === node.attrs.source,
  }
}

/** A picture, shown from the bytes just added when no version holds it yet. */
function imageView(node: ProseMirrorNode, previews: ReadonlyMap<string, string>): NodeView {
  const image = document.createElement("img")
  const show = (current: ProseMirrorNode) => {
    const attrs = tagAttributes(current.attrs.source as string | null)
    for (const name of image.getAttributeNames()) if (!(name in attrs)) image.removeAttribute(name)
    for (const [name, value] of Object.entries(attrs)) image.setAttribute(name, value)
    const preview = previews.get(attrs.src ?? "")
    if (preview) image.src = preview
  }
  show(node)
  image.draggable = false
  return {
    dom: image,
    ignoreMutation: () => true,
    update: (next) => {
      if (next.type !== node.type) return false
      show(next)
      return true
    },
  }
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

function placeholder(node: ProseMirrorNode, text: EditorWords): string {
  if (node.type.name !== "textBlock") return ""
  const tag = tagOf(node)
  if (tag === "li") return text.listItem
  const heading = /^h([1-6])$/.exec(tag)
  if (heading) return text.headings[Number(heading[1]) - 1] ?? ""
  return SINGLE_BLOCK_TAGS.has(tag) ? "" : text.placeholder
}

function imagesOf(data: DataTransfer | null | undefined): File[] {
  return Array.from(data?.files ?? []).filter((file) => file.type.startsWith("image/"))
}

/** Markup pasted from elsewhere without its attributes, but for where a link or picture points. */
function plainHtml(html: string): string {
  const template = document.createElement("template")
  template.innerHTML = html
  const keep = new Set(["href", "src", "alt", "colspan", "rowspan"])
  for (const element of Array.from(template.content.querySelectorAll("*"))) {
    for (const name of element.getAttributeNames()) {
      if (!keep.has(name)) element.removeAttribute(name)
    }
  }
  return template.innerHTML
}
