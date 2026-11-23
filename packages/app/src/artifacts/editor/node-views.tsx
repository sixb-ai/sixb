import {
  type ComponentType,
  createContext,
  type DragEvent,
  type ElementType,
  type HTMLAttributes,
  type ReactNode,
  useContext,
  useSyncExternalStore,
} from "react"
import { createPortal } from "react-dom"
import type { Attrs, Node } from "./core/model"
import { NodeSelection } from "./core/state"
import type { EditorView, NodeView, NodeViewFactory } from "./core/view"

// Nodes drawn by React components: each draws into an element the editor owns, through a portal
// the document editor renders, so the components keep the app's context. The element is a
// `div.react-renderer.node-<type>`; the component draws a `NodeViewWrapper` in it and, for a node
// with content, a `NodeViewContent` the editor's own element for that content goes into, as
// Tiptap's React node views (MIT) draw them. And nodes drawn with plain DOM: a to-do's checkbox, a
// table's column widths.

export interface NodeViewProps {
  readonly node: Node
  readonly selected: boolean
  readonly editable: boolean
  readonly updateAttributes: (attrs: Attrs) => void
  /** Puts the focus back in the editor's text. */
  readonly focusEditor: () => void
}

interface Portal {
  readonly key: number
  readonly target: HTMLElement
  readonly element: ReactNode
}

/** The node views drawn by React, for the document editor to render as portals. */
export class NodeViewPortals {
  private portals: readonly Portal[] = []
  private readonly listeners = new Set<() => void>()
  private next = 0

  subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
  get = () => this.portals

  set(key: number, target: HTMLElement, element: ReactNode): void {
    const others = this.portals.filter((portal) => portal.key !== key)
    this.portals = [...others, { key, target, element }]
    for (const listener of this.listeners) listener()
  }

  remove(key: number): void {
    this.portals = this.portals.filter((portal) => portal.key !== key)
    for (const listener of this.listeners) listener()
  }

  key(): number {
    this.next += 1
    return this.next
  }
}

export function NodeViewPortalsHost({ portals }: { readonly portals: NodeViewPortals }) {
  const list = useSyncExternalStore(portals.subscribe, portals.get, portals.get)
  return (
    <>{list.map((portal) => createPortal(portal.element, portal.target, String(portal.key)))}</>
  )
}

/** Events inside a React view's own controls are its own: the editor leaves them alone. */
function stopEvent(
  view: { dom: HTMLElement; contentDOM?: HTMLElement | null },
  node: Node,
  event: Event
): boolean {
  const target = event.target as HTMLElement | null
  if (!target || !view.dom.contains(target) || view.contentDOM?.contains(target)) return false
  const isDrag = event.type.startsWith("drag") || event.type === "drop"
  const isInput =
    ["INPUT", "BUTTON", "SELECT", "TEXTAREA"].includes(target.tagName) || target.isContentEditable
  if (isInput && !isDrag) return true
  if (isDrag || ["copy", "paste", "cut"].includes(event.type)) return false
  if (event.type === "mousedown" && NodeSelection.isSelectable(node)) return false
  return true
}

interface ViewContextValue {
  readonly contentRef: (element: HTMLElement | null) => void
  readonly onDragStart: (event: DragEvent<HTMLElement>) => void
}

const ViewContext = createContext<ViewContextValue>({ contentRef: () => {}, onDragStart: () => {} })

/** A React node view's outer element; `as` names its tag, and is kept on it as an attribute. */
export function NodeViewWrapper(props: { readonly as?: string } & HTMLAttributes<HTMLElement>) {
  const { onDragStart } = useContext(ViewContext)
  const Tag = (props.as ?? "div") as ElementType
  return (
    <Tag
      {...props}
      data-node-view-wrapper=""
      onDragStart={onDragStart}
      style={{ whiteSpace: "normal", ...props.style }}
    />
  )
}

/** Where a React node view's content goes: the editor's element for it is put inside. */
export function NodeViewContent({
  as: Tag = "div",
  ...props
}: { readonly as?: ElementType } & HTMLAttributes<HTMLElement>) {
  const { contentRef } = useContext(ViewContext)
  return (
    <Tag
      {...props}
      ref={contentRef}
      data-node-view-content=""
      style={{ whiteSpace: "pre-wrap", ...props.style }}
    />
  )
}

/** A node drawn by `Component`, which draws a `NodeViewWrapper` and, for content, a `NodeViewContent`. */
export function reactNodeView(
  portals: NodeViewPortals,
  Component: ComponentType<NodeViewProps>
): NodeViewFactory {
  return (initial: Node, view: EditorView, getPos: () => number | undefined) => {
    const key = portals.key()
    const document = view.document
    const dom = document.createElement(initial.isInline ? "span" : "div")
    dom.classList.add("react-renderer", `node-${initial.type.name}`)
    // The content's own element, inside `dom` until the component's `NodeViewContent` takes it.
    let contentDOM: HTMLElement | null = null
    if (!initial.isLeaf) {
      contentDOM = document.createElement(initial.isInline ? "span" : "div")
      contentDOM.dataset.nodeViewContentReact = ""
      contentDOM.dataset.nodeViewWrapper = ""
      contentDOM.style.whiteSpace = "inherit"
      dom.appendChild(contentDOM)
    }
    const contentRef = (element: HTMLElement | null) => {
      if (!element || !contentDOM || element.firstChild === contentDOM) return
      if (element.hasAttribute("data-node-view-wrapper"))
        element.removeAttribute("data-node-view-wrapper")
      const restore = keepSelection(contentDOM)
      element.appendChild(contentDOM)
      restore?.()
    }
    // Dragged by an element marked `data-drag-handle`, the node moves whole, its picture as drawn.
    const onDragStart = (event: DragEvent<HTMLElement>) => {
      const target = event.target as HTMLElement
      const handle = (target.nodeType === 3 ? target.parentElement : target)?.closest(
        "[data-drag-handle]"
      )
      if (contentDOM?.contains(target) || !handle) return
      let x = 0
      let y = 0
      if (dom !== handle) {
        const domBox = dom.getBoundingClientRect()
        const handleBox = handle.getBoundingClientRect()
        x = handleBox.x - domBox.x + event.nativeEvent.offsetX
        y = handleBox.y - domBox.y + event.nativeEvent.offsetY
      }
      const clone = dom.cloneNode(true) as HTMLElement
      const box = dom.getBoundingClientRect()
      clone.style.width = `${Math.round(box.width)}px`
      clone.style.height = `${Math.round(box.height)}px`
      clone.style.boxSizing = "border-box"
      clone.style.pointerEvents = "none"
      const holder = document.createElement("div")
      holder.style.position = "absolute"
      holder.style.top = "-9999px"
      holder.style.left = "-9999px"
      holder.style.pointerEvents = "none"
      holder.appendChild(clone)
      document.body.appendChild(holder)
      event.dataTransfer?.setDragImage(clone, x, y)
      setTimeout(() => holder.remove(), 0)
      const pos = getPos()
      if (pos === undefined) return
      view.dispatch(view.state.tr.setSelection(NodeSelection.create(view.state.doc, pos)))
    }
    const context: ViewContextValue = { contentRef, onDragStart }
    let node = initial
    let selected = false
    const render = () =>
      portals.set(
        key,
        dom,
        <ViewContext.Provider value={context}>
          <Component
            node={node}
            selected={selected}
            editable={view.editable}
            updateAttributes={(attrs) => {
              const pos = getPos()
              if (pos === undefined) return
              view.dispatch(
                view.state.tr.setNodeMarkup(pos, undefined, { ...node.attrs, ...attrs })
              )
            }}
            focusEditor={() => view.focus()}
          />
        </ViewContext.Provider>
      )
    render()
    const nodeView: NodeView = {
      dom,
      contentDOM,
      update: (next) => {
        if (next.type !== node.type) return false
        if (next === node) return true
        node = next
        render()
        return true
      },
      selectNode: () => {
        selected = true
        dom.classList.add("is-picked")
        render()
      },
      deselectNode: () => {
        selected = false
        dom.classList.remove("is-picked")
        render()
      },
      stopEvent: (event) => stopEvent({ dom, contentDOM }, node, event),
      destroy: () => portals.remove(key),
    }
    return nodeView
  }
}

/** Puts the browser's selection back after `element` moves, when it was inside it. */
function keepSelection(element: HTMLElement): (() => void) | null {
  const selection = element.ownerDocument.getSelection()
  if (!selection || selection.rangeCount === 0) return null
  const { anchorNode, anchorOffset, focusNode, focusOffset } = selection
  if (!anchorNode || !focusNode || !element.contains(anchorNode) || !element.contains(focusNode))
    return null
  return () => {
    try {
      selection.setBaseAndExtent(anchorNode, anchorOffset, focusNode, focusOffset)
    } catch {
      // A position the browser will not select.
    }
  }
}

/** A to-do: its checkbox, which checks it, then its words. */
export function taskItemView(
  node: Node,
  view: EditorView,
  getPos: () => number | undefined
): NodeView {
  const document = view.document
  const item = document.createElement("li")
  const label = document.createElement("label")
  const styler = document.createElement("span")
  const checkbox = document.createElement("input")
  const content = document.createElement("div")
  styler.style.cssText =
    "position: absolute; width: 1px; height: 1px; padding: 0px; margin: -1px; overflow: hidden; clip: rect(0px, 0px, 0px, 0px); white-space: nowrap; border: 0px;"
  label.contentEditable = "false"
  checkbox.type = "checkbox"
  checkbox.addEventListener("mousedown", (event) => event.preventDefault())
  let current = node
  const sync = (next: Node) => {
    const text = `Task item checkbox for ${next.textContent || "empty task item"}`
    checkbox.setAttribute("aria-label", text)
    styler.textContent = text
    item.dataset.checked = String(next.attrs.checked)
    checkbox.checked = next.attrs.checked === true
  }
  checkbox.addEventListener("change", () => {
    if (!view.editable) {
      checkbox.checked = !checkbox.checked
      return
    }
    const pos = getPos()
    if (pos === undefined) return
    view.focus()
    view.dispatch(
      view.state.tr.setNodeMarkup(pos, undefined, { ...current.attrs, checked: checkbox.checked })
    )
  })
  sync(node)
  label.append(checkbox, styler)
  item.append(label, content)
  return {
    dom: item,
    contentDOM: content,
    update: (next) => {
      if (next.type !== current.type) return false
      current = next
      sync(next)
      return true
    },
    stopEvent: (event) =>
      event.target === checkbox || label.contains(event.target as globalThis.Node),
  }
}

/** A table, its columns kept at least as wide as a cell can be. */
export function tableView(node: Node, view: EditorView): NodeView {
  const document = view.document
  const wrapper = document.createElement("div")
  wrapper.className = "tableWrapper"
  const table = wrapper.appendChild(document.createElement("table"))
  const colgroup = table.appendChild(document.createElement("colgroup"))
  const body = table.appendChild(document.createElement("tbody"))
  const columns = (next: Node) => {
    const count = next.firstChild?.childCount ?? 0
    while (colgroup.children.length > count) colgroup.lastChild?.remove()
    while (colgroup.children.length < count) {
      const col = document.createElement("col")
      col.style.setProperty("min-width", "25px")
      colgroup.append(col)
    }
    table.style.width = ""
    table.style.minWidth = `${count * 25}px`
  }
  columns(node)
  let current = node
  return {
    dom: wrapper,
    contentDOM: body,
    update: (next) => {
      if (!next.sameMarkup(current)) return false
      current = next
      columns(next)
      return true
    },
  }
}
