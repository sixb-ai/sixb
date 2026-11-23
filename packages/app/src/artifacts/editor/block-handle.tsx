import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@sixb/ui/components"
import { ArrowDown, ArrowUp, Copy, GripVertical, Plus, Repeat2, Trash2 } from "lucide-react"
import { useCallback, useEffect, useRef, useState } from "react"
import type { RelativePosition } from "yjs"
import type { BlockChoice, BlockType } from "./blocks"
import { insertContentAt } from "./core/commands"
import type { Editor } from "./core/editor"
import type { Node } from "./core/model"
import { NodeSelection, TextSelection } from "./core/state"
import { floatingPosition } from "./floating"
import type { EditorMessages } from "./messages"

// The handle beside the block the pointer is over: `+` adds a block below and opens the `/` menu
// there; the grip drags the block, and a click on it opens what can be done to it. While its menu
// is open, the handle stays with its block.

interface Hovered {
  readonly node: Node
  readonly pos: number
}

export function BlockHandle({
  editor,
  types,
  messages,
}: {
  readonly editor: Editor
  readonly types: readonly BlockType[]
  readonly messages: EditorMessages
}) {
  const hovered = useRef<Hovered | null>(null)
  const handle = useRef<HTMLDivElement | null>(null)
  const [menu, setMenu] = useState(false)
  const locked = useRef(false)
  /** The block the handle is beside, and where, as the handle follows it: by position, and by
   * a Yjs position for others' changes, after which the document is read whole again. */
  const current = useRef<Node | null>(null)
  const at = useRef(-1)
  const relative = useRef<RelativePosition | null>(null)
  const [shown, setShown] = useState(false)

  /** Puts the handle at the start of its block's first line. */
  const place = useCallback((dom: Element) => {
    const element = handle.current
    if (!element) return
    const { x, y } = floatingPosition(dom.getBoundingClientRect(), element, {
      placement: "left-start",
    })
    element.style.left = `${x}px`
    element.style.top = `${y}px`
  }, [])

  const hide = useCallback(() => {
    hovered.current = null
    current.current = null
    at.current = -1
    relative.current = null
    setShown(false)
  }, [])

  // The top-level block under the pointer, found once a frame as it moves.
  useEffect(() => {
    const view = editor.view
    let frame = 0
    let pending: { x: number; y: number } | null = null
    const find = () => {
      frame = 0
      if (!pending || locked.current) return
      const { x, y } = pending
      pending = null
      const block = blockAt(editor, x, y)
      if (!block || block.node === current.current) return
      current.current = block.node
      at.current = block.pos
      relative.current = editor.binding.relative(block.pos)
      hovered.current = { node: block.node, pos: block.pos }
      place(block.dom)
      setShown(editor.isEditable)
    }
    const move = (event: MouseEvent) => {
      if (locked.current) return
      pending = { x: event.clientX, y: event.clientY }
      if (!frame) frame = requestAnimationFrame(find)
    }
    const leave = (event: MouseEvent) => {
      if (locked.current) return
      if (handle.current?.parentElement?.contains(event.relatedTarget as globalThis.Node | null))
        return
      hide()
    }
    const key = () => {
      if (locked.current || !view.hasFocus()) return
      hide()
    }
    view.dom.addEventListener("mousemove", move)
    view.dom.addEventListener("mouseleave", leave)
    view.dom.addEventListener("keydown", key)
    // The handle stays at the position it was at: after a change, beside whatever block is there
    // now. The block pointed at moves with what anyone changes before it, while its menu is
    // open too; one taken out is pointed at no more.
    let previousDoc = editor.state.doc
    const offTransaction = editor.on("transaction", ({ transaction }) => {
      const doc = editor.state.doc
      if (at.current !== -1 && doc !== previousDoc && transaction) {
        if (transaction.getMeta("remote")) {
          at.current = (relative.current && editor.binding.absolute(relative.current)) || 0
        } else if (transaction.docChanged) {
          const pos = transaction.mapping.map(at.current)
          if (pos !== at.current) {
            at.current = pos
            relative.current = editor.binding.relative(pos)
          }
        }
      }
      if (doc !== previousDoc && !doc.eq(previousDoc) && at.current !== -1) {
        let dom = editor.view.nodeDOM(
          Math.min(at.current, doc.content.size)
        ) as globalThis.Node | null
        while (dom?.parentNode && dom.parentNode !== view.dom) dom = dom.parentNode
        if (dom && dom !== view.dom && dom.nodeType === 1) {
          const $pos = doc.resolve(Math.max(0, view.posFromDOM(dom, 0, -1)))
          const pos = $pos.depth > 0 ? $pos.before(1) : $pos.pos
          const node = doc.nodeAt(pos)
          if (node) {
            current.current = node
            at.current = pos
            relative.current = editor.binding.relative(pos)
            if (!locked.current) hovered.current = { node, pos }
            place(dom as Element)
          }
        }
      }
      previousDoc = doc
      // While its menu is open, the block it acts on moves with what anyone changes before it.
      const pointed = hovered.current
      if (!pointed || !locked.current || !transaction?.docChanged) return
      const mapped = transaction.mapping.mapResult(pointed.pos)
      const node = mapped.deleted ? null : doc.nodeAt(mapped.pos)
      hovered.current = node ? { node, pos: mapped.pos } : null
    })
    return () => {
      cancelAnimationFrame(frame)
      view.dom.removeEventListener("mousemove", move)
      view.dom.removeEventListener("mouseleave", leave)
      view.dom.removeEventListener("keydown", key)
      offTransaction()
    }
  }, [editor, place, hide])

  const block = () => {
    const current = hovered.current
    if (!current) return null
    const node = editor.state.doc.nodeAt(current.pos)
    return node ? { node, pos: current.pos } : null
  }

  const addBelow = () => {
    const at = block()
    if (!at) return
    const after = at.pos + at.node.nodeSize
    // An empty paragraph is reused; anything else gets a new one below it.
    if (at.node.type.name === "paragraph" && at.node.content.size === 0) {
      editor.run((tr) => {
        tr.setSelection(TextSelection.near(tr.doc.resolve(at.pos + 1)))
        return insertContentAt({ from: tr.selection.from, to: tr.selection.to }, "/")(tr)
      })
      editor.focus()
      return
    }
    editor.run((tr) => {
      insertContentAt(after, editor.schema.nodeType("paragraph").create())(tr)
      tr.setSelection(TextSelection.near(tr.doc.resolve(after + 1)))
      return insertContentAt({ from: tr.selection.from, to: tr.selection.to }, "/")(tr)
    })
    editor.focus()
  }

  const duplicate = () => {
    const at = block()
    if (!at) return
    editor.run(
      insertContentAt(at.pos + at.node.nodeSize, editor.schema.nodeFromJSON(at.node.toJSON()))
    )
    editor.focus()
  }

  const remove = () => {
    const at = block()
    if (!at) return
    editor.run((tr) => {
      tr.delete(at.pos, at.pos + at.node.nodeSize)
      return true
    })
    editor.focus()
  }

  const move = (by: -1 | 1) => {
    const at = block()
    if (!at) return
    const $pos = editor.state.doc.resolve(at.pos)
    const sibling = $pos.parent.maybeChild($pos.index() + by)
    if (!sibling) return
    const target = by === 1 ? at.pos + sibling.nodeSize : at.pos - sibling.nodeSize
    const tr = editor.state.tr
    tr.delete(at.pos, at.pos + at.node.nodeSize)
    tr.insert(target, at.node)
    editor.dispatch(tr.scrollIntoView())
    // Where it went, which mapping its old place cannot tell.
    hovered.current = { node: at.node, pos: target }
    editor.focus()
  }

  const turnInto = (type: BlockType) => {
    const at = block()
    if (!at) return
    // Its words are selected, so the block they are in becomes the new one.
    editor.dispatch(
      editor.state.tr.setSelection(
        TextSelection.create(editor.state.doc, at.pos + 1, at.pos + at.node.nodeSize - 1)
      )
    )
    type.make(editor)
  }

  /** The grip drags its block: the block is picked and dropped where it lands. */
  const dragStart = (event: React.DragEvent) => {
    const at = block()
    if (!at || !event.dataTransfer) return
    const selection = NodeSelection.create(editor.state.doc, at.pos)
    editor.dispatch(editor.state.tr.setSelection(selection))
    const dom = editor.view.nodeDOM(at.pos)
    if (dom instanceof HTMLElement) event.dataTransfer.setDragImage(dom, 0, 0)
    event.dataTransfer.effectAllowed = "copyMove"
    event.dataTransfer.setData("text/plain", at.node.textContent)
    editor.view.dragging = { slice: selection.content(), move: true, node: selection }
  }

  const textual = (node: Node | undefined) => !!node && node.isTextblock

  return (
    <div className="pointer-events-none absolute top-0 left-0 z-10">
      <div
        ref={handle}
        className="sixb-editor-handle"
        draggable={!menu}
        onDragStart={dragStart}
        onDragEnd={hide}
        style={{
          position: "absolute",
          visibility: shown && editor.isEditable ? undefined : "hidden",
          pointerEvents: shown ? "auto" : "none",
        }}
      >
        <div className="flex items-center gap-0.5 pr-2">
          <button
            type="button"
            aria-label={messages.handle.add}
            title={messages.handle.add}
            className="sixb-editor-handle-button"
            onClick={addBelow}
          >
            <Plus className="size-[18px]" strokeWidth={1.75} />
          </button>
          <DropdownMenu
            open={menu}
            onOpenChange={(open) => {
              setMenu(open)
              locked.current = open
            }}
          >
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                aria-label={messages.handle.menu}
                title={`${messages.handle.drag}\n${messages.handle.menu}`}
                className="sixb-editor-handle-button cursor-grab active:cursor-grabbing"
              >
                <GripVertical className="size-[18px]" strokeWidth={1.75} />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent
              side="left"
              align="start"
              sideOffset={6}
              className="w-56"
              onCloseAutoFocus={(event) => {
                event.preventDefault()
                editor.focus()
              }}
            >
              <BlockMenuItems
                textual={textual(hovered.current?.node)}
                types={types}
                messages={messages}
                onTurnInto={(id) => {
                  const type = types.find((each) => each.id === id)
                  if (type) turnInto(type)
                }}
                onDuplicate={duplicate}
                onMove={move}
                onRemove={remove}
              />
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
    </div>
  )
}

/** The top-level block beside a point: the pointer is kept within the blocks' column. */
function blockAt(
  editor: Editor,
  x: number,
  y: number
): { node: Node; pos: number; dom: Element } | null {
  const view = editor.view
  const blocks = Array.from(view.dom.children).filter(
    (child) => child.getBoundingClientRect().height > 0
  )
  const first = blocks[0]?.getBoundingClientRect()
  const last = blocks[blocks.length - 1]?.getBoundingClientRect()
  if (!first || !last) return null
  const inset = 5
  const clampedY = Math.min(Math.max(first.top + inset, y), last.bottom - inset)
  const clampedX = Math.min(Math.max(first.left + inset, x), first.right - inset)
  const elements = view.document.elementsFromPoint(clampedX, clampedY)
  let dom: Element | null = null
  for (const element of elements) {
    if (!view.dom.contains(element) || element === view.dom) continue
    let current: Element | null = element
    while (current?.parentElement && current.parentElement !== view.dom)
      current = current.parentElement
    if (current?.parentElement === view.dom) {
      dom = current
      break
    }
  }
  if (!dom) {
    const found = view.posAtCoords({ left: clampedX, top: clampedY })
    if (!found) return null
    const $pos = editor.state.doc.resolve(found.pos)
    const pos = $pos.depth > 0 ? $pos.before(1) : $pos.pos
    const node = editor.state.doc.nodeAt(pos)
    const nodeDom = view.nodeDOM(pos)
    return node && nodeDom instanceof Element ? { node, pos, dom: nodeDom } : null
  }
  const pos = view.posFromDOM(dom, 0, -1)
  const $pos = editor.state.doc.resolve(Math.max(0, pos))
  const blockPos = $pos.depth > 0 ? $pos.before(1) : $pos.pos
  const node = editor.state.doc.nodeAt(blockPos)
  return node ? { node, pos: blockPos, dom } : null
}

/** What can be done to a block from its handle's menu, whichever editor it is in. */
export function BlockMenuItems({
  textual,
  types,
  messages,
  onTurnInto,
  onDuplicate,
  onMove,
  onRemove,
}: {
  /** Whether it holds words, which "Turn into" changes. */
  readonly textual: boolean
  readonly types: readonly BlockChoice[]
  readonly messages: EditorMessages
  readonly onTurnInto: (id: string) => void
  readonly onDuplicate: () => void
  readonly onMove: (by: -1 | 1) => void
  readonly onRemove: () => void
}) {
  return (
    <>
      {textual ? (
        <DropdownMenuSub>
          <DropdownMenuSubTrigger>
            <Repeat2 className="text-muted-foreground" />
            {messages.blockMenu.turnInto}
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent className="w-52">
            {types
              .filter((type) => type.turnsInto)
              .map((type) => {
                const Icon = type.icon
                return (
                  <DropdownMenuItem key={type.id} onSelect={() => onTurnInto(type.id)}>
                    <Icon className="text-muted-foreground" />
                    {type.label}
                  </DropdownMenuItem>
                )
              })}
          </DropdownMenuSubContent>
        </DropdownMenuSub>
      ) : null}
      <DropdownMenuItem onSelect={onDuplicate}>
        <Copy className="text-muted-foreground" />
        {messages.blockMenu.duplicate}
        <DropdownMenuShortcut>⌘D</DropdownMenuShortcut>
      </DropdownMenuItem>
      <DropdownMenuItem onSelect={() => onMove(-1)}>
        <ArrowUp className="text-muted-foreground" />
        {messages.blockMenu.moveUp}
        <DropdownMenuShortcut>⌥⇧↑</DropdownMenuShortcut>
      </DropdownMenuItem>
      <DropdownMenuItem onSelect={() => onMove(1)}>
        <ArrowDown className="text-muted-foreground" />
        {messages.blockMenu.moveDown}
        <DropdownMenuShortcut>⌥⇧↓</DropdownMenuShortcut>
      </DropdownMenuItem>
      <DropdownMenuSeparator />
      <DropdownMenuItem variant="destructive" onSelect={onRemove}>
        <Trash2 />
        {messages.blockMenu.delete}
        <DropdownMenuShortcut>Del</DropdownMenuShortcut>
      </DropdownMenuItem>
    </>
  )
}
