// Loaded only when a canvas opens, so React Flow's code stays out of every other artifact's bundle.
// Its stylesheet, canvas.css, is part of the framework's.
import type { Canvas } from "@sixb/core/artifacts"
import {
  Background,
  BackgroundVariant,
  type FitViewOptions,
  ReactFlow,
  ReactFlowProvider,
} from "@xyflow/react"
import { memo, useMemo } from "react"
import { useArtifactMessages } from "../../messages"
import { CANVAS_EDGE_TYPES } from "./arrows"
import { CanvasControls } from "./controls"
import { CANVAS_NODE_TYPES } from "./items"
import { canvasGraph } from "./layout"

/** Room around what the board fits to, as a share of the view. */
const PADDING = 0.12

/**
 * A canvas on an endless board: drag or scroll to pan, pinch or ⌘-scroll to zoom, the zoom
 * controls in a corner. It opens on the item an address named, else fitted to everything.
 */
export default memo(function CanvasBoard({
  canvas,
  title,
  mode,
  focus,
}: {
  readonly canvas: Canvas
  readonly title: string
  /**
   * The mode the board draws in. React Flow marks its root with it, and the app's light tokens
   * answer to `.light` as well as the root, so a board left at its default draws light in dark mode.
   */
  readonly mode: "light" | "dark"
  /** An item to open on, as `artifact:…#id` names one. */
  readonly focus?: string
}) {
  return (
    <ReactFlowProvider>
      <Board canvas={canvas} title={title} mode={mode} {...(focus ? { focus } : {})} />
    </ReactFlowProvider>
  )
})

function Board({
  canvas,
  title,
  mode,
  focus,
}: {
  readonly canvas: Canvas
  readonly title: string
  readonly mode: "light" | "dark"
  readonly focus?: string
}) {
  const messages = useArtifactMessages().canvas
  const { nodes, edges } = useMemo(() => canvasGraph(canvas), [canvas])
  const fitOptions = useMemo<FitViewOptions>(() => {
    const item = focus ? canvas.items.find((candidate) => candidate.id === focus) : undefined
    // An item with a box opens filling the view; an arrow or a text opens the whole canvas.
    const framed = item && item.type !== "arrow" && item.type !== "text"
    return { padding: PADDING, maxZoom: 1, ...(framed ? { nodes: [{ id: item.id }] } : {}) }
  }, [canvas, focus])
  return (
    <div
      className="sixb-canvas sixb-artboard relative size-full bg-background"
      role="region"
      aria-label={messages.canvas(title)}
    >
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={CANVAS_NODE_TYPES}
        edgeTypes={CANVAS_EDGE_TYPES}
        colorMode={mode}
        fitView
        fitViewOptions={fitOptions}
        minZoom={0.04}
        maxZoom={2.5}
        // Scroll pans, as a design tool's board does; a pinch, or ⌘ or Ctrl with scroll, zooms.
        panOnScroll
        zoomOnScroll={false}
        zoomOnPinch
        zoomActivationKeyCode={["Meta", "Control"]}
        panOnDrag
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable={false}
        proOptions={{ hideAttribution: true }}
      >
        <Background variant={BackgroundVariant.Dots} gap={24} size={1.3} />
        <CanvasControls padding={PADDING} />
      </ReactFlow>
    </div>
  )
}
