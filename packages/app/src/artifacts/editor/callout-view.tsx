import { NodeViewContent, type NodeViewProps, NodeViewWrapper } from "@tiptap/react"
import { CALLOUT_KINDS } from "../renderers/document-tree"
import { calloutIcon } from "./blocks"

/**
 * A callout as it reads, its kind's icon beside its blocks. A click on the icon takes it to the
 * next kind: note, tip, important, warning, caution.
 */
export function CalloutView({ node, updateAttributes, editor }: NodeViewProps) {
  const kind = String(node.attrs.kind)
  const Icon = calloutIcon(kind)
  const next = () => {
    const index = CALLOUT_KINDS.indexOf(kind as (typeof CALLOUT_KINDS)[number])
    updateAttributes({ kind: CALLOUT_KINDS[(index + 1) % CALLOUT_KINDS.length] })
  }
  return (
    <NodeViewWrapper as="aside" className="sixb-callout" data-callout={kind}>
      <button
        type="button"
        contentEditable={false}
        disabled={!editor.isEditable}
        className="sixb-callout-kind"
        aria-label={kind}
        onClick={next}
      >
        <Icon className="sixb-callout-icon" aria-hidden="true" />
      </button>
      <NodeViewContent className="sixb-callout-body" />
    </NodeViewWrapper>
  )
}
