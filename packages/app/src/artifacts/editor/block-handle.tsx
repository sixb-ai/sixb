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
import type { Editor } from "@tiptap/core"
import { DragHandle } from "@tiptap/extension-drag-handle-react"
import type { Node as ProseMirrorNode } from "@tiptap/pm/model"
import { TextSelection } from "@tiptap/pm/state"
import { ArrowDown, ArrowUp, Copy, GripVertical, Plus, Repeat2, Trash2 } from "lucide-react"
import { useRef, useState } from "react"
import type { BlockType } from "./blocks"
import type { EditorMessages } from "./messages"

// The handle beside the block the pointer is over: `+` adds a block below and opens the `/` menu
// there; the grip drags the block, and a click on it opens what can be done to it. While its menu
// is open, the handle stays with its block.

/**
 * Where the handle sits: at the start of its block's first line. One object for the editor's
 * life: the handle registers its plugin again whenever this changes, which ends any open `/` menu.
 */
const HANDLE_POSITION = { placement: "left-start", strategy: "absolute" } as const

interface Hovered {
  readonly node: ProseMirrorNode
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
  const [menu, setMenu] = useState(false)

  const block = () => {
    const current = hovered.current
    if (!current) return null
    // The block may have moved since it was pointed at: read it again where it is.
    const node = editor.state.doc.nodeAt(current.pos)
    return node ? { node, pos: current.pos } : null
  }

  const lock = (locked: boolean) => {
    const commands = editor.commands as unknown as Record<string, () => boolean>
    commands[locked ? "lockDragHandle" : "unlockDragHandle"]?.()
  }

  const addBelow = () => {
    const at = block()
    if (!at) return
    const after = at.pos + at.node.nodeSize
    // An empty paragraph is reused; anything else gets a new one below it.
    if (at.node.type.name === "paragraph" && at.node.content.size === 0) {
      editor
        .chain()
        .focus(at.pos + 1)
        .insertContent("/")
        .run()
      return
    }
    editor
      .chain()
      .insertContentAt(after, { type: "paragraph" })
      .focus(after + 1)
      .insertContent("/")
      .run()
  }

  const duplicate = () => {
    const at = block()
    if (!at) return
    editor
      .chain()
      .insertContentAt(at.pos + at.node.nodeSize, at.node.toJSON())
      .focus()
      .run()
  }

  const remove = () => {
    const at = block()
    if (!at) return
    editor
      .chain()
      .deleteRange({ from: at.pos, to: at.pos + at.node.nodeSize })
      .focus()
      .run()
  }

  const move = (by: -1 | 1) => {
    const at = block()
    if (!at) return
    const $pos = editor.state.doc.resolve(at.pos)
    const index = $pos.index()
    const parent = $pos.parent
    const sibling = parent.maybeChild(index + by)
    if (!sibling) return
    const tr = editor.state.tr
    if (by === 1) {
      tr.delete(at.pos, at.pos + at.node.nodeSize)
      tr.insert(at.pos + sibling.nodeSize, at.node)
      hovered.current = { node: at.node, pos: at.pos + sibling.nodeSize }
    } else {
      const target = at.pos - sibling.nodeSize
      tr.delete(at.pos, at.pos + at.node.nodeSize)
      tr.insert(target, at.node)
      hovered.current = { node: at.node, pos: target }
    }
    editor.view.dispatch(tr.scrollIntoView())
    editor.commands.focus()
  }

  const turnInto = (type: BlockType) => {
    const at = block()
    if (!at) return
    // Its words are selected, so the block they are in becomes the new one.
    const tr = editor.state.tr.setSelection(
      TextSelection.create(editor.state.doc, at.pos + 1, at.pos + at.node.nodeSize - 1)
    )
    editor.view.dispatch(tr)
    type.make(editor)
  }

  const textual = (node: ProseMirrorNode | undefined) => !!node && node.isTextblock

  return (
    <DragHandle
      editor={editor}
      className="sixb-editor-handle"
      onNodeChange={({ node, pos }) => {
        if (!menu) hovered.current = node ? { node, pos } : null
      }}
      computePositionConfig={HANDLE_POSITION}
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
            lock(open)
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
              editor.commands.focus()
            }}
          >
            {textual(hovered.current?.node) ? (
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
                        <DropdownMenuItem key={type.id} onSelect={() => turnInto(type)}>
                          <Icon className="text-muted-foreground" />
                          {type.label}
                        </DropdownMenuItem>
                      )
                    })}
                </DropdownMenuSubContent>
              </DropdownMenuSub>
            ) : null}
            <DropdownMenuItem onSelect={duplicate}>
              <Copy className="text-muted-foreground" />
              {messages.blockMenu.duplicate}
              <DropdownMenuShortcut>⌘D</DropdownMenuShortcut>
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => move(-1)}>
              <ArrowUp className="text-muted-foreground" />
              {messages.blockMenu.moveUp}
              <DropdownMenuShortcut>⌥⇧↑</DropdownMenuShortcut>
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => move(1)}>
              <ArrowDown className="text-muted-foreground" />
              {messages.blockMenu.moveDown}
              <DropdownMenuShortcut>⌥⇧↓</DropdownMenuShortcut>
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem variant="destructive" onSelect={remove}>
              <Trash2 />
              {messages.blockMenu.delete}
              <DropdownMenuShortcut>Del</DropdownMenuShortcut>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </DragHandle>
  )
}
