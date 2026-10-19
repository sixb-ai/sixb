import type { ArtifactTone, CanvasItem, CanvasShape, CanvasTextSize } from "@sixb/core/artifacts"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@sixb/ui/components"
import { cn } from "@sixb/ui/lib/utils"
import { Panel } from "@xyflow/react"
import {
  ChevronDown,
  Circle,
  Copy,
  Diamond,
  Frame,
  type LucideIcon,
  RectangleHorizontal,
  Spline,
  StickyNote,
  Trash2,
  Type,
} from "lucide-react"
import { type ReactNode, useEffect, useState } from "react"
import { useArtifactMessages } from "../../messages"
import { TONE_COLORS } from "../../tones"
import type { ItemStyle, NewItem } from "./draft"

/**
 * The colors the toolbar offers, its default first: a note's is amber, so amber is its default,
 * and paper its plain; a shape's default is plain, and amber one of its colors.
 */
const NOTE_TONES: readonly (ArtifactTone | null)[] = [
  null,
  "positive",
  "negative",
  "neutral",
  "chart-1",
  "chart-3",
]
const SHAPE_TONES: readonly (ArtifactTone | null)[] = [
  null,
  "positive",
  "warning",
  "negative",
  "chart-1",
  "chart-3",
]
const SIZES: readonly CanvasTextSize[] = ["s", "m", "l", "xl"]
const SHAPES: readonly { readonly shape: CanvasShape; readonly icon: LucideIcon }[] = [
  { shape: "rect", icon: RectangleHorizontal },
  { shape: "ellipse", icon: Circle },
  { shape: "diamond", icon: Diamond },
]

/**
 * The canvas's tools while it is edited, floating over its top: add a note, a text, a shape, or a
 * section; and, for what is selected, its color, its text's size, its shape, an arrow's line and
 * label, and Duplicate and Delete.
 */
export function CanvasToolbar({
  selection,
  onAdd,
  onStyle,
  onDuplicate,
  onDelete,
}: {
  readonly selection: readonly CanvasItem[]
  readonly onAdd: (kind: NewItem, shape?: CanvasShape) => void
  readonly onStyle: (style: ItemStyle) => void
  readonly onDuplicate: () => void
  readonly onDelete: () => void
}) {
  const messages = useArtifactMessages().canvas.toolbar
  const toned = selection.filter((item) => item.type === "note" || item.type === "shape")
  const texts = selection.filter((item) => item.type === "text")
  const shapes = selection.filter((item) => item.type === "shape")
  const arrows = selection.filter((item) => item.type === "arrow")
  const arrow = arrows.length === 1 ? arrows[0] : undefined
  const one = <Value,>(values: readonly Value[]) =>
    values.every((value) => value === values[0]) ? values[0] : undefined
  const tone = one(toned.map((item) => ("tone" in item ? (item.tone ?? null) : null)))
  const tones = toned.some((item) => item.type === "note") ? NOTE_TONES : SHAPE_TONES
  const size = one(texts.map((item) => (item.type === "text" ? item.size : undefined)))
  const shape = one(shapes.map((item) => (item.type === "shape" ? item.shape : undefined)))
  const dashed = one(arrows.map((item) => (item.type === "arrow" ? item.dashed : false)))
  return (
    <Panel position="top-center" className="!mt-3">
      <div
        role="toolbar"
        aria-label={messages.label}
        className="flex items-center gap-0.5 rounded-xl border border-border bg-background/95 p-1 shadow-[0_1px_2px_rgb(0_0_0/0.06),0_10px_28px_-14px_rgb(0_0_0/0.3)] backdrop-blur"
      >
        <Tool label={messages.note} onClick={() => onAdd("note")}>
          <StickyNote />
        </Tool>
        <Tool label={messages.text} onClick={() => onAdd("text")}>
          <Type />
        </Tool>
        <DropdownMenu modal={false}>
          <DropdownMenuTrigger
            aria-label={messages.shape}
            title={messages.shape}
            className={cn(TOOL, "w-auto gap-0.5 px-1.5")}
          >
            <RectangleHorizontal />
            <ChevronDown className="!size-3 opacity-60" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="center" sideOffset={8}>
            {SHAPES.map(({ shape: kind, icon: Icon }) => (
              <DropdownMenuItem key={kind} onSelect={() => onAdd("shape", kind)}>
                <Icon aria-hidden="true" />
                {messages.shapes[kind]}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
        <Tool label={messages.section} onClick={() => onAdd("section")}>
          <Frame />
        </Tool>
        {selection.length > 0 ? (
          <>
            <Divider />
            {toned.length > 0 ? (
              <div
                className="flex items-center gap-1 px-1"
                role="group"
                aria-label={messages.color}
              >
                {tones.map((entry) => (
                  <button
                    key={entry ?? "default"}
                    type="button"
                    aria-label={messages.tones[entry ?? "default"]}
                    title={messages.tones[entry ?? "default"]}
                    aria-pressed={tone === entry}
                    onClick={() => onStyle({ tone: entry })}
                    className="flex size-6 items-center justify-center rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <span
                      aria-hidden="true"
                      className={cn(
                        "size-[18px] rounded-full ring-1 ring-[color-mix(in_oklab,var(--foreground)_14%,transparent)] transition-shadow",
                        tone === entry &&
                          "ring-2 ring-foreground ring-offset-2 ring-offset-background"
                      )}
                      style={{ background: swatch(entry, toned) }}
                    />
                  </button>
                ))}
              </div>
            ) : null}
            {texts.length > 0 ? (
              <Segments label={messages.size}>
                {SIZES.map((entry) => (
                  <Segment
                    key={entry}
                    label={messages.sizes[entry]}
                    pressed={size === entry}
                    onClick={() => onStyle({ size: entry })}
                  >
                    <span className="text-xs font-semibold uppercase">{entry}</span>
                  </Segment>
                ))}
              </Segments>
            ) : null}
            {shapes.length > 0 ? (
              <Segments label={messages.shape}>
                {SHAPES.map(({ shape: kind, icon: Icon }) => (
                  <Segment
                    key={kind}
                    label={messages.shapes[kind]}
                    pressed={shape === kind}
                    onClick={() => onStyle({ shape: kind })}
                  >
                    <Icon />
                  </Segment>
                ))}
              </Segments>
            ) : null}
            {arrows.length > 0 ? (
              <Segments label={messages.line}>
                <Segment
                  label={messages.solid}
                  pressed={dashed === false}
                  onClick={() => onStyle({ dashed: false })}
                >
                  <Spline />
                </Segment>
                <Segment
                  label={messages.dashed}
                  pressed={dashed === true}
                  onClick={() => onStyle({ dashed: true })}
                >
                  <Spline className="[stroke-dasharray:3_3]" />
                </Segment>
              </Segments>
            ) : null}
            {arrow?.type === "arrow" ? (
              <LabelField
                key={arrow.id}
                value={arrow.label ?? ""}
                placeholder={messages.label_}
                onCommit={(label) => onStyle({ label })}
              />
            ) : null}
            <Divider />
            <Tool label={messages.duplicate} onClick={onDuplicate}>
              <Copy />
            </Tool>
            <Tool label={messages.delete} onClick={onDelete}>
              <Trash2 />
            </Tool>
          </>
        ) : null}
      </div>
    </Panel>
  )
}

/** A swatch's fill: the tone as a note or a shape takes it, its default as the selection's kind. */
function swatch(tone: ArtifactTone | null, items: readonly CanvasItem[]): string {
  const note = items.some((item) => item.type === "note")
  if (tone === null) {
    return note ? `color-mix(in oklab, ${TONE_COLORS.warning} 32%, var(--card))` : "var(--card)"
  }
  if (tone === "neutral") return "var(--card)"
  return `color-mix(in oklab, ${TONE_COLORS[tone]} 40%, var(--card))`
}

/** An arrow's label, stored as it is left or on Enter. */
function LabelField({
  value,
  placeholder,
  onCommit,
}: {
  readonly value: string
  readonly placeholder: string
  readonly onCommit: (label: string) => void
}) {
  const [text, setText] = useState(value)
  useEffect(() => setText(value), [value])
  return (
    <input
      value={text}
      aria-label={placeholder}
      placeholder={placeholder}
      maxLength={120}
      onChange={(event) => setText(event.target.value)}
      onBlur={() => onCommit(text)}
      onKeyDown={(event) => {
        event.stopPropagation()
        if (event.key === "Enter") onCommit(text)
      }}
      className="mx-1 h-7 w-36 rounded-md border border-border bg-background px-2 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring"
    />
  )
}

const TOOL =
  "flex size-8 shrink-0 items-center justify-center rounded-lg text-muted-foreground outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring [&_svg]:size-4"

function Tool({
  label,
  onClick,
  children,
}: {
  readonly label: string
  readonly onClick: () => void
  readonly children: ReactNode
}) {
  return (
    <button type="button" aria-label={label} title={label} onClick={onClick} className={TOOL}>
      {children}
    </button>
  )
}

function Segments({ label, children }: { readonly label: string; readonly children: ReactNode }) {
  return (
    <div role="group" aria-label={label} className="flex items-center rounded-lg bg-muted/60 p-0.5">
      {children}
    </div>
  )
}

function Segment({
  label,
  pressed,
  onClick,
  children,
}: {
  readonly label: string
  readonly pressed: boolean
  readonly onClick: () => void
  readonly children: ReactNode
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      aria-pressed={pressed}
      onClick={onClick}
      className={cn(
        "flex h-7 min-w-7 items-center justify-center rounded-md px-1.5 text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring [&_svg]:size-4",
        pressed && "bg-background text-foreground shadow-sm"
      )}
    >
      {children}
    </button>
  )
}

function Divider() {
  return <span aria-hidden="true" className="mx-1 h-5 w-px bg-border" />
}
