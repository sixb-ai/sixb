// Loaded only when a canvas opens, so React Flow's code stays out of every other artifact's bundle.
// Its stylesheet, canvas.css, is part of the framework's.
import type { Canvas, CanvasBoard as CanvasBoardItem } from "@sixb/core/artifacts"
import {
  Background,
  BackgroundVariant,
  type FitViewOptions,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  useStore,
} from "@xyflow/react"
import { memo, useCallback, useMemo, useRef, useState } from "react"
import { useArtifactMessages } from "../../messages"
import type { ArtifactVersion } from "../../queries"
import { CANVAS_EDGE_TYPES } from "./arrows"
import { LiveBoardsProvider, liveBoards } from "./board"
import { CanvasControls } from "./controls"
import { BoardFocus } from "./focus"
import { CANVAS_NODE_TYPES } from "./items"
import { canvasGraph } from "./layout"

/** Room around what the board fits to, as a share of the view. */
const PADDING = 0.12

/**
 * A canvas on an endless board: drag or scroll to pan, pinch or ⌘-scroll to zoom, the zoom
 * controls in a corner. Boards run live as the view comes to them;
 * double-click one, press Enter on it, or press its Open to open it over the canvas. It opens on
 * the item an address named, else fitted to everything.
 */
export default memo(function CanvasBoard({
  canvas,
  version,
  title,
  mode,
  focus,
}: {
  readonly canvas: Canvas
  /** The version the canvas is, whose frames its boards run in; none draws boards as tiles. */
  readonly version?: ArtifactVersion
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
      <Board
        canvas={canvas}
        title={title}
        mode={mode}
        {...(version ? { version } : {})}
        {...(focus ? { focus } : {})}
      />
    </ReactFlowProvider>
  )
})

function Board({
  canvas,
  version,
  title,
  mode,
  focus,
}: {
  readonly canvas: Canvas
  readonly version?: ArtifactVersion
  readonly title: string
  readonly mode: "light" | "dark"
  readonly focus?: string
}) {
  const messages = useArtifactMessages().canvas
  const { nodes, edges } = useMemo(() => canvasGraph(canvas), [canvas])
  const boards = useMemo(
    () => canvas.items.filter((item): item is CanvasBoardItem => item.type === "board"),
    [canvas]
  )
  // The boards to run, as a key, so the board view draws again only when they change, not on
  // every frame of a pan. Those running keep running while they are on screen.
  const running = useRef<ReadonlySet<string>>(new Set())
  const liveKey = useStore((state) => {
    running.current = liveBoards(
      boards,
      { transform: state.transform, width: state.width, height: state.height },
      running.current
    )
    return [...running.current].sort().join(" ")
  })
  // A board an address names opens over the canvas, which sits behind it fitted to it.
  const [opened, setOpened] = useState<string | null>(() =>
    focus && boards.some((board) => board.id === focus) ? focus : null
  )
  const { fitView } = useReactFlow()
  const close = useCallback(() => {
    const id = opened
    setOpened(null)
    if (id) void fitView({ nodes: [{ id }], padding: PADDING, maxZoom: 1, duration: 220 })
  }, [opened, fitView])
  const live = useMemo(
    () => ({
      version: version ?? null,
      live: new Set(liveKey ? liveKey.split(" ") : []),
      ...(version ? { open: setOpened } : {}),
    }),
    [version, liveKey]
  )
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
      onKeyDown={(event) => {
        // Enter on a board, as the keyboard reaches it, opens it.
        if (event.key !== "Enter" || !live.open) return
        const id = (event.target as HTMLElement)
          .closest(".react-flow__node")
          ?.getAttribute("data-id")
        if (id && boards.some((board) => board.id === id)) live.open(id)
      }}
    >
      <LiveBoardsProvider value={live}>
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
          onNodeDoubleClick={(_, node) => {
            if (node.type === "board") live.open?.(node.id)
          }}
          proOptions={{ hideAttribution: true }}
        >
          <Background variant={BackgroundVariant.Dots} gap={24} size={1.3} />
          <CanvasControls padding={PADDING} />
        </ReactFlow>
      </LiveBoardsProvider>
      {opened && version ? (
        <BoardFocus
          version={version}
          boards={boards}
          id={opened}
          onOpen={setOpened}
          onClose={close}
        />
      ) : null}
    </div>
  )
}
