import { isArtifactAddress } from "@sixb/core/artifacts"
import { isPageEntry, LIVE_FILES, PAGE_BODY } from "@sixb/core/artifacts/live"
import { Awareness, applyAwarenessUpdate } from "y-protocols/awareness"
import * as Y from "yjs"
import {
  extendMarkRange,
  getMarkAttributes,
  isMarkActive,
  setMark,
  unsetMark,
} from "../editor/core/commands"
import { Editor, type EditorPlugin } from "../editor/core/editor"
import { Fragment, type MarkType, type Node as ProseMirrorNode, Slice } from "../editor/core/model"
import {
  baseKeymap,
  caretsPlugin,
  historyPlugin,
  placeholderPlugin,
  Suggestion,
} from "../editor/core/plugins"
import { NodeSelection, Selection, TextSelection } from "../editor/core/state"
import type { Mappable } from "../editor/core/transform"
import type { Decoration, EditorView, NodeView } from "../editor/core/view"
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
import { pageKeys } from "./keys"
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
import { pageSchema, sanitize, startTag, tagAttributes } from "./schema"
import { PAGE_EDITOR_CSS } from "./style"

// A designed document's editor, running in its frame on the page itself: the body is the editor,
// so the page's stylesheets style what is typed as they style the page. It edits a copy of the
// live document the app keeps in step through the port, and tells the app what to draw over the
// frame: the toolbar over selected words, the `/` menu, the handle beside the block the pointer
// is over, and where a dragged block would land. See ./protocol.ts.

/** The origin of what the app sends, which is never sent back. */
const FROM_APP = Symbol("app")

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

  // Each key typed filters the kinds again and picks the first.
  const openMenu = (range: { from: number; to: number }, query: string) => {
    slash = { items: findBlockTypes(blocks, query), index: 0, range }
    schedule()
  }

  const choose = (index: number) => {
    const current = editor
    const item = slash?.items[index]
    const range = slash?.range
    if (!current || !item || !range) return
    slash = null
    if (item.id === "image") {
      current.run((tr) => !!tr.delete(range.from, range.to))
      current.focus()
      post({ type: "pickImage", at: tell(wordsAt(current.state.selection)?.pos ?? null) })
      return
    }
    insertBlock(current, item.id, range)
  }

  const suggestion = new Suggestion("/", {
    // Not in `<pre>`, where `/` is a character like any other.
    allow: (state, range) => {
      const parent = state.doc.resolve(range.from).parent
      return parent.type.name === "textBlock" && tagOf(parent) !== "pre"
    },
    onStart: (state) => openMenu(state.range, state.query ?? ""),
    onUpdate: (state) => openMenu(state.range, state.query ?? ""),
    onKeyDown: (event) => {
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
  })

  // ── Page breaks, as the sheet shows them ──────────────────────────────

  let pageBreakLabel = ""
  /**
   * Where the page breaks, as last measured, carried through what changed since; a break whose
   * place a change took out goes until the next measure.
   */
  let breaks: { readonly pos: number; readonly key: string }[] = []
  const pageBreaksPlugin: EditorPlugin = {
    apply: (tr) => {
      if (!tr.docChanged) return
      breaks = breaks.flatMap((each) => {
        const mapped = tr.mapping.mapResult(each.pos, -1)
        return mapped.deleted ? [] : [{ pos: mapped.pos, key: each.key }]
      })
    },
    decorations: () =>
      breaks.map(
        ({ pos, key }): Decoration => ({
          kind: "widget",
          pos,
          side: -1,
          key,
          ignoreSelection: true,
          toDOM: () => pageBreak(pageBreakLabel),
        })
      ),
    view: (current) => {
      let timer: ReturnType<typeof setTimeout> | undefined
      let shown = ""
      const measure = () => {
        const at = pageBreaks(current.view)
        const key = at.join(",")
        if (key === shown) return
        shown = key
        breaks = at.map((pos) => ({ pos, key: `break-${pos}` }))
        current.view.updateState(current.state)
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
        update: (_editor, previous) => {
          if (current.state.doc !== previous.doc) later()
        },
        destroy: () => {
          clearTimeout(timer)
          window.removeEventListener("resize", later)
        },
      }
    },
  }

  // ── Marks and links ───────────────────────────────────────────────────

  const markType = (tag: string) => pageSchema.marks[tag] as MarkType
  const toggleMark = (current: Editor, mark: PageMark) => {
    const tags = MARK_TAGS[mark]
    current.run((tr) => {
      if (tags.some((tag) => isMarkActive(tr, markType(tag)))) {
        for (const tag of tags) unsetMark(markType(tag))(tr)
      } else {
        const tag = tags[0] as string
        setMark(markType(tag), { open: `<${tag}>`, close: `</${tag}>` })(tr)
      }
      return true
    })
    current.focus()
  }

  const setLink = (current: Editor, href: string | null) => {
    current.run((tr) => {
      extendMarkRange(markType("a"))(tr)
      if (href === null) return unsetMark(markType("a"))(tr)
      // A link keeps whatever else its tag says, its class among them.
      const attrs = {
        ...tagAttributes(getMarkAttributes(tr, markType("a")).open as string | undefined),
        href,
      }
      return setMark(markType("a"), { open: startTag("a", attrs), close: "</a>" })(tr)
    })
    current.focus()
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
        return suggestion.exit(current.view)
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
        current.dispatch(tr.scrollIntoView())
        current.focus()
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
        current.dispatch(state.tr.setSelection(NodeSelection.create(state.doc, command.pos)))
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
        const image = pageSchema.nodeType("image").create({
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
        current.dispatch(tr.scrollIntoView())
        current.focus()
        return
      }
      case "focus":
        current.focus()
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
    body.classList.add("sixb-page-editor")
    let made: Editor | null = null
    const current = () => made as Editor
    // What the editor's own props do before any plugin: links are for reading, and pictures
    // pasted or dropped go to the app to store.
    const props: EditorPlugin = {
      handleDOMEvents: {
        // A link is for reading: in the editor, a click puts the caret in its words.
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
      // And of its pictures, only the artifact's own: the page could not be saved with any
      // other.
      transformPasted: (slice) => {
        const files = doc.getMap<unknown>(LIVE_FILES)
        const content = withOwnImages(slice.content, (src) => isOwnImage(src, files))
        if (content === slice.content) return slice
        const open = Slice.maxOpen(content)
        return new Slice(
          content,
          Math.min(slice.openStart, open.openStart),
          Math.min(slice.openEnd, open.openEnd)
        )
      },
      clipboardTextSerializer: () => textBetween(current().state.doc, current().state.selection),
    }
    made = new Editor({
      mount: body,
      fragment,
      schema: pageSchema,
      editable,
      awareness,
      attributes: { role: "textbox", ...(bodyClass ? { class: bodyClass } : {}) },
      nodeViews: {
        raw: (node) => rawView(node, false),
        rawInline: (node) => rawView(node, true),
        image: (node) => imageView(node, previews),
      },
      plugins: [
        props,
        historyPlugin(current),
        pageBreaksPlugin,
        suggestion.plugin(() => made?.isEditable ?? false),
        pageKeys(current, { toggleMark, onLink: () => post({ type: "linkRequest" }) }),
        placeholderPlugin(
          (node) => placeholder(node, text),
          () => made?.isEditable ?? false
        ),
        caretsPlugin(awareness, {
          render: caret,
          selection: (user) => ({
            nodeName: "span",
            class: "sixb-caret-selection",
            style: `--caret: ${user.color ?? "#888"}`,
          }),
        }),
        baseKeymap(null),
      ],
    })
    // A page with no blocks yet gets one to type in, which opening it adds without undo.
    if (made.isEditable && fragment.length === 0) {
      made.dispatch(
        made.state.tr
          .replaceWith(0, made.state.doc.content.size, words(pageSchema, "p"))
          .setMeta("addToHistory", false)
      )
    }
    // The caret starts at the first words.
    made.dispatch(
      made.state.tr.setSelection(Selection.atStart(made.state.doc)).setMeta("addToHistory", false)
    )
    made.on("transaction", ({ transaction }) => {
      if (transaction?.docChanged) mapTold(transaction.mapping)
      schedule()
    })
    made.on("focus", () => {
      post({ type: "focus", focused: true })
      schedule()
    })
    made.on("blur", () => post({ type: "focus", focused: false }))
    editor = made
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
  const tr = editor.state.tr
  const markType = (tag: string) => pageSchema.marks[tag] as MarkType
  const active = (tags: readonly string[]) => tags.some((tag) => isMarkActive(tr, markType(tag)))
  const link = isMarkActive(tr, markType("a"))
    ? (tagAttributes(getMarkAttributes(tr, markType("a")).open as string | undefined).href ?? "")
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

/** The selection's words, each block a blank line after what came before, line breaks as new lines. */
function textBetween(doc: ProseMirrorNode, selection: Selection): string {
  const { from, to } = selection
  let text = ""
  doc.nodesBetween(from, to, (node, pos, parent) => {
    if (node.isBlock && pos > from) text += "\n\n"
    if (node.type.name === "hardBreak") {
      if (parent) text += "\n"
      return false
    }
    if (node.isText) text += (node.text ?? "").slice(Math.max(from, pos) - pos, to - pos)
    return true
  })
  return text
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

/**
 * `content` without the pictures `own` does not take, nor the markup kept as written that shows
 * one; the same fragment when it holds none. A box they leave empty gets what it must hold.
 */
function withOwnImages(content: Fragment, own: (src: string) => boolean): Fragment {
  let changed = false
  const kept: ProseMirrorNode[] = []
  content.forEach((node) => {
    const source = node.attrs.source
    if (node.isAtom && typeof source === "string" && !imageSources(source).every(own)) {
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

/** Where the pictures of markup point. */
function imageSources(source: string): string[] {
  const template = document.createElement("template")
  template.innerHTML = source
  return Array.from(template.content.querySelectorAll("img[src]"), (image) =>
    (image.getAttribute("src") ?? "").trim()
  )
}

/** Whether publishing takes a picture: another artifact's, or one of `files` by its path. */
function isOwnImage(src: string, files: Y.Map<unknown>): boolean {
  if (isArtifactAddress(src)) return true
  if (src === "" || src.startsWith("/") || /^[a-z][a-z\d+.-]*:/i.test(src)) return false
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
  return files.has(segments.join("/"))
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
