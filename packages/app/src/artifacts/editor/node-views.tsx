import { type ComponentType, type ReactNode, useSyncExternalStore } from "react"
import { createPortal } from "react-dom"
import type { Attrs, Node } from "./core/model"
import { NodeSelection } from "./core/state"
import type { EditorView, NodeView, NodeViewFactory } from "./core/view"

// Nodes drawn by React components: each draws into DOM the editor owns, through a portal the
// document editor renders, so the components keep the app's context. And nodes drawn with plain
// DOM: a to-do's checkbox, a table's column widths.

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

/**
 * A node drawn by `Component` into `dom`: into `portal` within it, its content, if it has any, in
 * `contentDOM`.
 */
export function reactNodeView(
  portals: NodeViewPortals,
  Component: ComponentType<NodeViewProps>,
  make: (node: Node) => {
    readonly dom: HTMLElement
    readonly portal: HTMLElement
    readonly contentDOM?: HTMLElement
  },
  sync?: (dom: HTMLElement, node: Node) => void
): NodeViewFactory {
  return (initial: Node, view: EditorView, getPos: () => number | undefined) => {
    const key = portals.key()
    const { dom, portal, contentDOM } = make(initial)
    let node = initial
    let selected = false
    const render = () =>
      portals.set(
        key,
        portal,
        <Component
          node={node}
          selected={selected}
          editable={view.editable}
          updateAttributes={(attrs) => {
            const pos = getPos()
            if (pos === undefined) return
            view.dispatch(view.state.tr.setNodeMarkup(pos, undefined, { ...node.attrs, ...attrs }))
          }}
          focusEditor={() => view.focus()}
        />
      )
    render()
    const nodeView: NodeView = {
      dom,
      contentDOM: contentDOM ?? null,
      update: (next) => {
        if (next.type !== node.type) return false
        node = next
        sync?.(dom, next)
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
