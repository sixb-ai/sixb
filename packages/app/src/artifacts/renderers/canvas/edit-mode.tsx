import type { Canvas, CanvasItem, CanvasShape } from "@sixb/core/artifacts"
import {
  applyEdgeChanges,
  applyNodeChanges,
  type Connection,
  ConnectionMode,
  type Edge,
  type EdgeChange,
  type Node,
  type NodeChange,
  useStoreApi,
} from "@xyflow/react"
import {
  type KeyboardEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react"
import { useArtifactMessages } from "../../messages"
import {
  addItem,
  type CanvasChange,
  connectItems,
  duplicateItems,
  type ItemStyle,
  moveItems,
  type NewItem,
  removeItems,
  resizeItem,
  setItemText,
  styleItems,
} from "./draft"
import type { CanvasItemEditing } from "./editing"
import { canvasGraph } from "./layout"
import { CanvasToolbar } from "./toolbar"

/** What the board edits through: each change one step for undo. */
export interface CanvasEditor {
  readonly apply: (change: CanvasChange) => void
  readonly undo: () => void
  readonly redo: () => void
}

/** The grid items snap to as they move and resize. */
const GRID = 8
/** What an item added from the toolbar first measures, to place it in the middle of the view. */
const NEW_SIZES: Readonly<Record<NewItem, readonly [number, number]>> = {
  note: [240, 112],
  text: [200, 40],
  shape: [200, 120],
  section: [640, 400],
}

/**
 * The board while it is read, or edited: its nodes and arrows, and, editing, what React Flow
 * needs to select, drag, resize, and connect them, the items' editing, the toolbar, and the keys.
 * A drag, a resize, a connection, and each key are one change; what is selected stays selected as
 * the canvas changes under it.
 */
export function useBoardEditing(
  canvas: Canvas,
  edit: CanvasEditor | undefined,
  onOpenBoard: ((id: string) => void) | undefined
) {
  const messages = useArtifactMessages().canvas.toolbar
  const store = useStoreApi()
  const graph = useMemo(() => canvasGraph(canvas), [canvas])
  const editing = !!edit
  const [nodes, setNodes] = useState<Node[]>(graph.nodes)
  const [edges, setEdges] = useState<Edge[]>(graph.edges)
  const selected = useRef<ReadonlySet<string>>(new Set())
  const [selection, setSelection] = useState<ReadonlySet<string>>(new Set())
  const [typing, setTyping] = useState<string | null>(null)
  const root = useRef<HTMLDivElement | null>(null)

  // Drawn from the canvas as it changes, what was selected still selected.
  useEffect(() => {
    const chosen = selected.current
    setNodes(
      graph.nodes.map((node) =>
        editing && node.type !== "point"
          ? { ...node, draggable: true, selectable: true, selected: chosen.has(node.id) }
          : node
      )
    )
    setEdges(
      graph.edges.map((edge) =>
        editing ? { ...edge, selectable: true, selected: chosen.has(edge.id) } : edge
      )
    )
  }, [graph, editing])
  useEffect(() => {
    if (!editing) {
      selected.current = new Set()
      setSelection(new Set())
      setTyping(null)
    }
  }, [editing])

  /** Selects these items, in the nodes and arrows drawn now and in those drawn next. */
  const select = useCallback((ids: Iterable<string>) => {
    const chosen = new Set(ids)
    selected.current = chosen
    setSelection(chosen)
    setNodes((current) => current.map((node) => ({ ...node, selected: chosen.has(node.id) })))
    setEdges((current) => current.map((edge) => ({ ...edge, selected: chosen.has(edge.id) })))
  }, [])

  /** What a press or a box selected, by the select changes React Flow reports. */
  const chose = (changes: readonly (NodeChange | EdgeChange)[]) => {
    const next = new Set(selected.current)
    for (const change of changes) {
      if (change.type !== "select") continue
      if (change.selected) next.add(change.id)
      else next.delete(change.id)
    }
    selected.current = next
    setSelection(next)
  }

  const focusBoard = useCallback(() => root.current?.focus({ preventScroll: true }), [])

  const items: CanvasItemEditing | null = useMemo(
    () =>
      edit
        ? {
            typing,
            startTyping: setTyping,
            commitText: (id, text) => {
              edit.apply(setItemText(id, text))
              setTyping(null)
              focusBoard()
            },
            resize: (id, box) => edit.apply(resizeItem(id, box)),
          }
        : null,
    [edit, typing, focusBoard]
  )

  if (!edit) {
    return { nodes: graph.nodes, edges: graph.edges, editing: false as const, root }
  }

  const chosenItems = canvas.items.filter((item) => selection.has(item.id))

  const add = (kind: NewItem, shape?: CanvasShape) => {
    const { width, height, transform } = store.getState()
    const [x, y, zoom] = transform
    const [w, h] = NEW_SIZES[kind]
    const snap = (value: number) => Math.round(value / GRID) * GRID
    const at = {
      x: snap((width / 2 - x) / zoom - w / 2),
      y: snap((height / 2 - y) / zoom - h / 2),
    }
    const text = kind === "text" ? messages.newText : kind === "section" ? messages.newSection : ""
    const added = addItem(kind, at, text)
    const id = added.id(canvas)
    edit.apply((current) => {
      const next = added.change(current)
      return shape && shape !== "rect" ? styleItems(new Set([id]), { shape })(next) : next
    })
    select([id])
    // A note, a text, or a section is typed into as it appears; a shape waits for its words.
    if (kind !== "shape") setTyping(id)
  }

  const remove = () => {
    if (selection.size === 0) return
    edit.apply(removeItems(selection))
    select([])
  }

  const duplicate = () => {
    if (selection.size === 0) return
    const copies = duplicateItems(selection)
    const ids = copies.copies(canvas)
    edit.apply(copies.change)
    select(ids)
  }

  const nudge = (dx: number, dy: number) => {
    const positions = new Map(
      chosenItems.flatMap((item) =>
        item.type === "arrow" ? [] : [[item.id, { x: item.x + dx, y: item.y + dy }] as const]
      )
    )
    if (positions.size > 0) edit.apply(moveItems(positions))
  }

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement
    if (target.closest("input, textarea, select, [contenteditable], [role=dialog], [role=menu]")) {
      return
    }
    const command = event.metaKey || event.ctrlKey
    const key = event.key.toLowerCase()
    const handled = (() => {
      if (command && (key === "z" || key === "y")) {
        if (key === "y" || event.shiftKey) edit.redo()
        else edit.undo()
        return true
      }
      if (command && key === "d") {
        duplicate()
        return true
      }
      if (command && key === "a") {
        select(canvas.items.map((item) => item.id))
        return true
      }
      if (command) return false
      if (event.key === "Delete" || event.key === "Backspace") {
        remove()
        return true
      }
      if (event.key === "Escape") {
        select([])
        return true
      }
      const only = chosenItems.length === 1 ? (chosenItems[0] as CanvasItem) : undefined
      if (event.key === "Enter" && only) {
        if (only.type === "board") onOpenBoard?.(only.id)
        else if (only.type !== "embed" && only.type !== "arrow") setTyping(only.id)
        return true
      }
      // The arrows nudge what is selected a pixel; with Shift, a step of the grid.
      const step = event.shiftKey ? GRID : 1
      const moves: Record<string, readonly [number, number]> = {
        ArrowLeft: [-step, 0],
        ArrowRight: [step, 0],
        ArrowUp: [0, -step],
        ArrowDown: [0, step],
      }
      const move = moves[event.key]
      if (move && chosenItems.length > 0) {
        nudge(move[0], move[1])
        return true
      }
      return false
    })()
    if (handled) {
      event.preventDefault()
      event.stopPropagation()
    }
  }

  const toolbar: ReactNode = (
    <CanvasToolbar
      selection={chosenItems}
      onAdd={add}
      onStyle={(style: ItemStyle) => edit.apply(styleItems(selection, style))}
      onDuplicate={duplicate}
      onDelete={remove}
    />
  )

  return {
    nodes,
    edges,
    editing: true as const,
    root,
    items,
    toolbar,
    onKeyDown,
    flow: {
      // A press, Shift, or a box selects as React Flow reports it; what the board selects itself,
      // as an item is added or copied, it sets through `select`.
      onNodesChange: (changes: NodeChange[]) => {
        setNodes((current) => applyNodeChanges(changes, current))
        if (changes.some((change) => change.type === "select")) chose(changes)
      },
      onEdgesChange: (changes: EdgeChange[]) => {
        setEdges((current) => applyEdgeChanges(changes, current))
        if (changes.some((change) => change.type === "select")) chose(changes)
      },
      onNodeDragStop: (_: unknown, __: Node, dragged: Node[]) =>
        edit.apply(moveItems(new Map(dragged.map((node) => [node.id, node.position] as const)))),
      onConnect: (connection: Connection) =>
        edit.apply(connectItems(connection.source, connection.target)),
      onNodeDoubleClick: (_: unknown, node: Node) => {
        if (node.type === "board") onOpenBoard?.(node.id)
        else if (node.type !== "embed" && node.type !== "point") setTyping(node.id)
      },
      nodesDraggable: true,
      nodesConnectable: true,
      elementsSelectable: true,
      connectionMode: ConnectionMode.Loose,
      snapToGrid: true,
      snapGrid: [GRID, GRID] as [number, number],
      deleteKeyCode: null,
      multiSelectionKeyCode: ["Meta", "Control", "Shift"],
      connectionLineStyle: {
        stroke: "color-mix(in oklab, var(--primary) 70%, transparent)",
        strokeWidth: 2,
      },
    },
  }
}
