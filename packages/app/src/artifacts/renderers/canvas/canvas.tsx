// Loaded only when a canvas opens, so React Flow's code stays out of every other artifact's bundle.
// Its stylesheet, canvas.css, is part of the framework's.

import type { Canvas, CanvasArrow, CanvasBoard as CanvasBoardItem } from "@sixb/core/artifacts"
import { CANVAS_FIT_PADDING } from "@sixb/core/artifacts"
import {
  Background,
  BackgroundVariant,
  type FitViewOptions,
  type Node,
  Panel,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  useStoreApi,
} from "@xyflow/react"
import {
  type MouseEvent,
  memo,
  type RefObject,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react"
import type { LiveArtifact } from "../../live/session"
import { useArtifactMessages } from "../../messages"
import type { ArtifactVersion } from "../../queries"
import { useArtifactView } from "../../view-context"
import { CANVAS_EDGE_TYPES } from "./arrows"
import { LiveBoardsProvider, useLiveSet } from "./board"
import type { CommentPick } from "./board-editor"
import { CanvasCommentPins } from "./comment-pins"
import { CommentModeHint, CommentTools, useCanvasCommenting } from "./commenting"
import { CommentsPanel } from "./comments-panel"
import { CanvasControls } from "./controls"
import { type CanvasEditor, useBoardEditing } from "./edit-mode"
import { CanvasEditingProvider } from "./editing"
import { BoardFocus } from "./focus"
import { CANVAS_NODE_TYPES, NAME_SCALE, zoomMarks } from "./items"
import { PresenceLayer } from "./presence"
import { boardPreviewUrl, useBoardPreviews } from "./previews"

/**
 * A canvas on an endless board: drag or scroll to pan, pinch or ⌘-scroll to zoom, the zoom
 * controls in a corner. Boards and embeds run live once the view shows them large enough;
 * double-click a board, press Enter on it, or press its Open to open it over the canvas. It opens
 * on the item an address named, else fitted to everything. Given an editor, its items are
 * selected, moved, resized, connected, and typed into, with a toolbar to add more.
 */
export default memo(function CanvasBoard({
  canvas,
  version,
  title,
  mode,
  focus,
  edit,
  live,
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
  /** Edits the canvas; without it, it is read. */
  readonly edit?: CanvasEditor
  /** The live artifact the canvas is drawn from: who else is on it shows over it. */
  readonly live?: LiveArtifact
}) {
  return (
    <ReactFlowProvider>
      <Board
        canvas={canvas}
        title={title}
        mode={mode}
        {...(version ? { version } : {})}
        {...(focus ? { focus } : {})}
        {...(edit ? { edit } : {})}
        {...(live ? { liveArtifact: live } : {})}
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
  edit,
  liveArtifact,
}: {
  readonly canvas: Canvas
  readonly version?: ArtifactVersion
  readonly title: string
  readonly mode: "light" | "dark"
  readonly focus?: string
  readonly edit?: CanvasEditor
  readonly liveArtifact?: LiveArtifact
}) {
  const messages = useArtifactMessages().canvas
  const boards = useMemo(
    () => canvas.items.filter((item): item is CanvasBoardItem => item.type === "board"),
    [canvas]
  )
  const arrows = useMemo(
    () => canvas.items.filter((item): item is CanvasArrow => item.type === "arrow"),
    [canvas]
  )

  // Each board's picture, while it is rendered and once it is ready.
  const previews = useBoardPreviews(version)

  // The boards and embeds to run, as the view comes to them: each knows whether it is one, so a
  // pan draws nothing again. Those running keep running while they are on screen, and a board
  // whose picture is ready waits to be larger: its picture shows as much until then.
  const places = useMemo(
    () =>
      canvas.items.flatMap((item) =>
        item.type === "board" || item.type === "embed"
          ? [{ ...item, pictured: previews[item.id] === "ready" }]
          : []
      ),
    [canvas, previews]
  )
  const running = useLiveSet(places)

  // A board an address names opens over the canvas, which sits behind it fitted to it.
  const [opened, setOpened] = useState<string | null>(() =>
    focus && boards.some((board) => board.id === focus) ? focus : null
  )
  const { fitView } = useReactFlow()
  const close = useCallback(() => {
    const id = opened
    setOpened(null)
    if (!id) return

    void fitView({ nodes: [{ id }], padding: CANVAS_FIT_PADDING, maxZoom: 1, duration: 220 })
  }, [opened, fitView])
  const live = useMemo(
    () => ({
      version: version ?? null,
      live: running,
      previews,
      mode,
      ...(version ? { open: setOpened } : {}),
    }),
    [version, running, previews, mode]
  )
  // An opened board's picture, at its own size, under its page until the page is ready.
  const pictureOf = useCallback(
    (id: string) =>
      version && previews[id] === "ready" ? boardPreviewUrl(version, id, mode) : undefined,
    [version, previews, mode]
  )

  const board = useBoardEditing(canvas, edit, version ? setOpened : undefined)
  // What edits a board's elements in place: the live canvas, while the reader edits it.
  const editBoard = edit?.live?.editBoard
  const stopCapturing = edit?.live?.stopCapturing
  const boardEditor = useMemo(
    () => (editBoard && stopCapturing ? { editBoard, stopCapturing } : null),
    [editBoard, stopCapturing]
  )
  useNameScaleVariable(board.root)

  // Comments, on the canvas's latest version shown in the viewer.
  const view = useArtifactView()
  const commenting = useCanvasCommenting({
    artifactId:
      version && view && version.version === view.latestVersion ? version.artifactId : null,
    live: liveArtifact ?? null,
    title,
    boards,
    revision: view?.revision ?? version?.revision ?? 1,
  })
  const { getInternalNode, screenToFlowPosition } = useReactFlow()
  const { setCommenting, cancelDraft, draft } = commenting

  // C places a comment, wherever focus is but in a field; Esc gives it up.
  useEffect(() => {
    if (!commenting.enabled) return
    const onKey = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return
      const target = event.target
      if (
        target instanceof Element &&
        target.closest("input, textarea, select, [contenteditable]")
      ) {
        return
      }
      if (event.key.toLowerCase() === "c" && !event.repeat) {
        event.preventDefault()
        commenting.toggleCommenting()
      } else if (event.key === "Escape" && !opened && (draft || commenting.commenting)) {
        event.preventDefault()
        if (draft) cancelDraft()
        else setCommenting(false)
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [commenting, opened, draft, cancelDraft, setCommenting])

  // Placing a comment, a click on a board puts it there, and nothing is selected or moved.
  const placing = useMemo(
    () =>
      commenting.commenting
        ? {
            nodesDraggable: false,
            nodesConnectable: false,
            elementsSelectable: false,
            onNodeClick: (event: MouseEvent, node: Node) => {
              if (node.type !== "board") return
              const internal = getInternalNode(node.id)
              const item = boards.find((each) => each.id === node.id)
              if (!internal || !item) return

              const at = screenToFlowPosition({ x: event.clientX, y: event.clientY })
              const { x, y } = internal.internals.positionAbsolute
              commenting.pick(
                node.id,
                {
                  point: {
                    x: Math.min(1, Math.max(0, (at.x - x) / item.w)),
                    y: Math.min(1, Math.max(0, (at.y - y) / item.h)),
                  },
                },
                "canvas"
              )
            },
            onPaneClick: () => cancelDraft(),
          }
        : {},
    [commenting, getInternalNode, screenToFlowPosition, boards, cancelDraft]
  )

  /** Shows a thread's pin: its board fitted in view, or opened, when one is. */
  const showThread = useCallback(
    (id: string) => {
      commenting.setActive(id)
      const thread = commenting.threads.find((each) => each.comment.id === id)
      const on = thread?.comment.anchor.board
      if (!on || !boards.some((each) => each.id === on)) return
      if (opened) {
        if (opened !== on) setOpened(on)
        return
      }
      void fitView({ nodes: [{ id: on }], padding: CANVAS_FIT_PADDING, maxZoom: 1, duration: 260 })
    },
    [commenting, boards, opened, fitView]
  )

  // Read, the board's handlers stay the same from one draw to the next, so React Flow doesn't
  // draw every item again when the board does.
  const open = live.open
  const reading = useMemo(
    () => ({
      nodesDraggable: false,
      nodesConnectable: false,
      elementsSelectable: false,
      onNodeDoubleClick: (_: unknown, node: Node) => {
        if (node.type === "board") open?.(node.id)
      },
    }),
    [open]
  )

  // An item with a box opens filling the view; an arrow or a text opens the whole canvas. The
  // options stay the same object as the canvas changes: React Flow takes in each new one.
  const framed = useMemo(() => {
    const item = focus ? canvas.items.find((candidate) => candidate.id === focus) : undefined
    return item && item.type !== "arrow" && item.type !== "text" ? item.id : undefined
  }, [canvas, focus])
  const fitOptions = useMemo<FitViewOptions>(
    () => ({
      padding: CANVAS_FIT_PADDING,
      maxZoom: 1,
      ...(framed ? { nodes: [{ id: framed }] } : {}),
    }),
    [framed]
  )
  return (
    <div
      ref={board.root}
      // Editing, the board takes the keys: it is focused as typing ends.
      tabIndex={board.editing ? -1 : undefined}
      className="sixb-canvas sixb-artboard @container/canvas relative flex size-full bg-background outline-none"
      data-editing={board.editing ? "" : undefined}
      data-commenting={commenting.commenting ? "" : undefined}
      data-live={liveArtifact ? "" : undefined}
      role="region"
      aria-label={messages.canvas(title)}
      onKeyDown={(event) => {
        if (board.editing) {
          board.onKeyDown(event)
          return
        }
        // Enter on a board, as the keyboard reaches it, opens it.
        if (event.key !== "Enter" || !live.open) return
        const id = (event.target as HTMLElement)
          .closest(".react-flow__node")
          ?.getAttribute("data-id")
        if (id && boards.some((board) => board.id === id)) live.open(id)
      }}
    >
      <div className="relative h-full min-w-0 flex-1">
        <LiveBoardsProvider value={live}>
          <CanvasEditingProvider value={board.editing ? board.items : null}>
            <ReactFlow
              nodes={board.nodes}
              edges={board.edges}
              nodeTypes={CANVAS_NODE_TYPES}
              edgeTypes={CANVAS_EDGE_TYPES}
              colorMode={mode}
              fitView
              fitViewOptions={fitOptions}
              // Only what the view shows is drawn: a canvas holds up to a thousand items. Each is
              // drawn once at first, so notes and texts are measured, and an arrow draws while any
              // of the box between its ends is in view.
              onlyRenderVisibleElements
              minZoom={0.04}
              maxZoom={2.5}
              // Scroll pans, as a design tool's board does; a pinch, or ⌘ or Ctrl with scroll, zooms.
              panOnScroll
              zoomOnScroll={false}
              zoomOnPinch
              zoomActivationKeyCode={["Meta", "Control"]}
              // A double-click opens a board, or types into an item while editing: it never zooms.
              zoomOnDoubleClick={false}
              panOnDrag
              {...(board.editing ? board.flow : reading)}
              {...placing}
              proOptions={{ hideAttribution: true }}
            >
              <Background variant={BackgroundVariant.Dots} gap={24} size={1.3} />
              <CanvasControls padding={CANVAS_FIT_PADDING} />
              {liveArtifact ? <PresenceLayer live={liveArtifact} /> : null}
              {board.editing ? board.toolbar : null}
              {commenting.enabled ? (
                <>
                  <CanvasCommentPins
                    pins={commenting.pins}
                    active={commenting.active}
                    draft={draft?.where === "canvas" ? draft : null}
                    onOpen={(id) => {
                      commenting.setActive(id)
                      commenting.setPanel(true)
                    }}
                    onSubmitDraft={commenting.submitDraft}
                    onCancelDraft={cancelDraft}
                  />
                  <Panel position="top-right" className="!m-3">
                    <CommentTools commenting={commenting} />
                  </Panel>
                  {commenting.commenting ? (
                    <Panel position="top-center" className={board.editing ? "!mt-16" : "!mt-3"}>
                      <CommentModeHint onExit={() => setCommenting(false)} />
                    </Panel>
                  ) : null}
                </>
              ) : null}
            </ReactFlow>
          </CanvasEditingProvider>
        </LiveBoardsProvider>
        {opened && version ? (
          <BoardFocus
            version={version}
            boards={boards}
            arrows={arrows}
            id={opened}
            pictureOf={pictureOf}
            onOpen={setOpened}
            onClose={close}
            live={liveArtifact ?? null}
            canvas={boardEditor}
            mode={commenting.commenting ? "comment" : boardEditor ? "edit" : "read"}
            {...(commenting.enabled
              ? {
                  pins: commenting.pins,
                  activePin: commenting.active,
                  draft: draft?.where === "focus" ? draft : null,
                  tools: (
                    <CommentTools
                      commenting={commenting}
                      className="border-0 bg-transparent p-0 shadow-none"
                    />
                  ),
                  onEscape: () => {
                    if (draft) cancelDraft()
                    else if (commenting.commenting) setCommenting(false)
                    else return false
                    return true
                  },
                  onPick: (id: string, pick: CommentPick) => commenting.pick(id, pick, "focus"),
                  onOpenPin: (id: string) => {
                    commenting.setActive(id)
                    commenting.setPanel(true)
                  },
                  onSubmitDraft: commenting.submitDraft,
                  onCancelDraft: cancelDraft,
                }
              : {})}
          />
        ) : null}
      </div>
      {commenting.enabled && commenting.panel ? (
        <CommentsPanel
          threads={commenting.threads}
          loading={commenting.loading}
          failed={commenting.failed}
          filter={commenting.filter}
          active={commenting.active}
          placeOf={commenting.placeOf}
          nameOf={commenting.nameOf}
          canManage={commenting.canManage}
          onFilter={commenting.setFilter}
          onActivate={showThread}
          onReply={commenting.reply}
          onResolve={commenting.resolve}
          onDelete={commenting.remove}
          onSend={commenting.send}
          onClose={() => commenting.setPanel(false)}
        />
      ) : null}
    </div>
  )
}

/**
 * Sets on the board as it zooms how much names grow, {@link NAME_SCALE}, so names, headings, and
 * labels keep their size on screen, and whether it is far, so tiles stop breathing: no item draws
 * again for a frame of a zoom.
 */
function useNameScaleVariable(root: RefObject<HTMLDivElement | null>): void {
  const store = useStoreApi()

  useEffect(() => {
    let last = ""
    const update = () => {
      const element = root.current
      const marks = zoomMarks(store.getState().transform[2])
      const key = `${marks.nameScale} ${marks.far}`
      if (!element || key === last) return

      last = key
      element.style.setProperty(NAME_SCALE, marks.nameScale)
      element.toggleAttribute("data-far", marks.far)
    }

    update()
    return store.subscribe(update)
  }, [store, root])
}
