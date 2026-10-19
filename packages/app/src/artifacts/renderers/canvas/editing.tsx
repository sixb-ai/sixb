import { cn } from "@sixb/ui/lib/utils"
import { Handle, NodeResizer, Position } from "@xyflow/react"
import {
  type CSSProperties,
  createContext,
  type KeyboardEvent,
  type ReactNode,
  useContext,
  useLayoutEffect,
  useRef,
  useState,
} from "react"
import type { Box } from "./draft"

/** What an item needs to be edited in place: its words typed, and its box resized. */
export interface CanvasItemEditing {
  /** The item whose words are being typed. */
  readonly typing: string | null
  readonly startTyping: (id: string) => void
  /** Stores an item's words, and ends typing. */
  readonly commitText: (id: string, text: string) => void
  readonly resize: (id: string, box: Box) => void
}

const CanvasEditingContext = createContext<CanvasItemEditing | null>(null)

export function CanvasEditingProvider({
  value,
  children,
}: {
  readonly value: CanvasItemEditing | null
  readonly children: ReactNode
}) {
  return <CanvasEditingContext.Provider value={value}>{children}</CanvasEditingContext.Provider>
}

/** The canvas's editing, while it is edited; null while it is read. */
export function useCanvasEditing(): CanvasItemEditing | null {
  return useContext(CanvasEditingContext)
}

const SIDES = [
  ["top", Position.Top],
  ["right", Position.Right],
  ["bottom", Position.Bottom],
  ["left", Position.Left],
] as const

/**
 * An item's handles while the canvas is edited: a dot on each side to drag an arrow from, shown
 * on hover and while it is selected, and, selected, the handles that resize it.
 */
export function EditChrome({
  id,
  selected,
  resizable = true,
}: {
  readonly id: string
  readonly selected: boolean
  readonly resizable?: boolean
}) {
  const editing = useCanvasEditing()
  if (!editing) return null
  return (
    <>
      {SIDES.map(([side, position]) => (
        <Handle
          key={side}
          id={side}
          type="source"
          position={position}
          className="sixb-connect"
          data-selected={selected ? "" : undefined}
        />
      ))}
      {resizable ? (
        <NodeResizer
          isVisible={selected && editing.typing !== id}
          minWidth={40}
          minHeight={40}
          color="var(--primary)"
          handleClassName="sixb-resize-handle"
          lineClassName="sixb-resize-line"
          onResizeEnd={(_, box) =>
            editing.resize(id, { x: box.x, y: box.y, w: box.width, h: box.height })
          }
        />
      ) : null}
    </>
  )
}

/**
 * An item's words typed over it: a note's, a text's, a shape's, a title. Leaving it, Esc, or
 * Enter (⌘Enter where words take lines) stores them; it opens with them all selected, as a
 * design tool's does.
 */
export function InPlaceText({
  id,
  value,
  multiline = false,
  placeholder,
  className,
  style,
}: {
  readonly id: string
  readonly value: string
  readonly multiline?: boolean
  readonly placeholder?: string
  readonly className?: string
  readonly style?: CSSProperties
}) {
  const editing = useCanvasEditing()
  const [text, setText] = useState(value)
  const field = useRef<HTMLTextAreaElement & HTMLInputElement>(null)
  const done = useRef(false)
  // React Flow shows an item only once it is measured, and a hidden field takes no focus: it is
  // focused as soon as it can be.
  useLayoutEffect(() => {
    let frame = 0
    let tries = 0
    const take = () => {
      const element = field.current
      if (!element) return
      fitHeight(element)
      element.focus({ preventScroll: true })
      if (element.ownerDocument.activeElement === element) element.select()
      else if (tries++ < 10) frame = requestAnimationFrame(take)
    }
    take()
    return () => cancelAnimationFrame(frame)
  }, [])
  if (!editing) return null
  const commit = () => {
    if (done.current) return
    done.current = true
    editing.commitText(id, text)
  }
  const onKeyDown = (event: KeyboardEvent) => {
    event.stopPropagation()
    if (
      event.key === "Escape" ||
      (event.key === "Enter" && (!multiline || event.metaKey || event.ctrlKey))
    ) {
      event.preventDefault()
      commit()
    }
  }
  const shared = {
    value: text,
    placeholder,
    spellCheck: true,
    onBlur: commit,
    onKeyDown,
    style,
    className: cn(
      // Typed in the item's own type: a field takes the browser's otherwise.
      "nodrag nopan nowheel block w-full resize-none border-0 bg-transparent p-0 [font:inherit] [letter-spacing:inherit] text-inherit outline-none placeholder:text-current/40",
      className
    ),
  }
  return multiline ? (
    <textarea
      ref={field}
      rows={1}
      {...shared}
      onChange={(event) => {
        setText(event.target.value)
        fitHeight(event.target)
      }}
    />
  ) : (
    <input ref={field} {...shared} onChange={(event) => setText(event.target.value)} />
  )
}

/** A text area as tall as its words, as the note under it grows with them; an input as it is. */
function fitHeight(element: HTMLElement) {
  if (element.tagName !== "TEXTAREA") return
  element.style.height = "auto"
  element.style.height = `${element.scrollHeight}px`
}
