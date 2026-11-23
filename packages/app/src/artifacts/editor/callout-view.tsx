import { CALLOUT_KINDS } from "../renderers/document-tree"
import { calloutIcon } from "./blocks"
import type { Node } from "./core/model"
import type { NodeViewProps } from "./node-views"

/**
 * A callout as it reads, its kind's icon beside its blocks. A click on the icon takes it to the
 * next kind: note, tip, important, warning, caution.
 */
export function CalloutView({ node, updateAttributes, editable }: NodeViewProps) {
  const kind = String(node.attrs.kind)
  const Icon = calloutIcon(kind)
  const next = () => {
    const index = CALLOUT_KINDS.indexOf(kind as (typeof CALLOUT_KINDS)[number])
    updateAttributes({ kind: CALLOUT_KINDS[(index + 1) % CALLOUT_KINDS.length] })
  }
  return (
    <button
      type="button"
      contentEditable={false}
      disabled={!editable}
      className="sixb-callout-kind"
      aria-label={kind}
      onClick={next}
    >
      <Icon className="sixb-callout-icon" aria-hidden="true" />
    </button>
  )
}

/** A callout's DOM: the aside, its icon drawn by React first, then the blocks it holds. */
export function calloutDOM(node: Node): {
  dom: HTMLElement
  portal: HTMLElement
  contentDOM: HTMLElement
} {
  const dom = document.createElement("aside")
  dom.className = "sixb-callout"
  dom.setAttribute("data-callout", String(node.attrs.kind))
  const portal = document.createElement("span")
  portal.style.display = "contents"
  portal.contentEditable = "false"
  const contentDOM = document.createElement("div")
  contentDOM.className = "sixb-callout-body"
  dom.append(portal, contentDOM)
  return { dom, portal, contentDOM }
}

export function syncCallout(dom: HTMLElement, node: Node): void {
  dom.setAttribute("data-callout", String(node.attrs.kind))
}
