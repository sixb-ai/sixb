import type { BoardStyleProperty } from "@sixb/core/artifacts/live"
import { cn } from "@sixb/ui/lib/utils"
import {
  AlignCenter,
  AlignLeft,
  AlignRight,
  ImageIcon,
  ImageUp,
  LoaderCircle,
  RotateCcw,
} from "lucide-react"
import { type ReactNode, useEffect, useId, useRef, useState } from "react"
import { useArtifactMessages } from "../../messages"

// The properties of a board's element, as a compact panel: its colors, its words' size, weight
// and alignment, and its spacing and corners, each set in its inline style; and an image's
// picture and description. Each value shows as the element's source writes it; a value the page's
// stylesheet gives it shows nothing, and the field says it comes from the page.

/** What a style change asks for: each property's new value, or null to take it out. */
export type StyleChange = Readonly<Partial<Record<BoardStyleProperty, string | null>>>

/** Colors offered at a click; any other is typed in. */
const SWATCHES = [
  "#0f172a",
  "#475569",
  "#ffffff",
  "#2563eb",
  "#7c3aed",
  "#db2777",
  "#dc2626",
  "#ea580c",
  "#ca8a04",
  "#16a34a",
  "#0d9488",
] as const

const WEIGHTS = ["400", "500", "600", "700"] as const
const ALIGNS = [
  { value: "left", icon: AlignLeft },
  { value: "center", icon: AlignCenter },
  { value: "right", icon: AlignRight },
] as const

/**
 * An element's style: colors for every element, its words for a text or a box of them, and its
 * spacing. `onChange` makes the change, and says false when the value cannot be used.
 */
export function StylePanel({
  style,
  words,
  onChange,
}: {
  readonly style: Readonly<Record<string, string>>
  /** Whether the element holds words: its typography shows. */
  readonly words: boolean
  readonly onChange: (change: StyleChange) => boolean
}) {
  const messages = useArtifactMessages().canvas.edit
  const background = style.background ?? style["background-color"]
  const setBackground = (value: string | null) =>
    onChange(
      style.background !== undefined
        ? { background: value }
        : { "background-color": null, background: value }
    )

  return (
    <div className="flex w-[17rem] flex-col gap-3.5" data-board-tools="">
      <Section title={messages.colors}>
        <ColorField
          label={messages.textColor}
          value={style.color}
          onChange={(value) => onChange({ color: value })}
        />
        <ColorField label={messages.background} value={background} onChange={setBackground} />
      </Section>
      {words ? (
        <Section title={messages.typography}>
          <LengthField
            label={messages.fontSize}
            value={style["font-size"]}
            onChange={(value) => onChange({ "font-size": value })}
          />
          <Row label={messages.weight}>
            <Segments label={messages.weight}>
              {WEIGHTS.map((weight) => (
                <Segment
                  key={weight}
                  label={messages.weights[weight]}
                  pressed={normalWeight(style["font-weight"]) === weight}
                  onClick={() =>
                    onChange({
                      "font-weight": normalWeight(style["font-weight"]) === weight ? null : weight,
                    })
                  }
                >
                  <span className="text-xs" style={{ fontWeight: Number(weight) }}>
                    Aa
                  </span>
                </Segment>
              ))}
            </Segments>
          </Row>
          <Row label={messages.align}>
            <Segments label={messages.align}>
              {ALIGNS.map(({ value, icon: Icon }) => (
                <Segment
                  key={value}
                  label={messages.aligns[value]}
                  pressed={style["text-align"] === value}
                  onClick={() =>
                    onChange({ "text-align": style["text-align"] === value ? null : value })
                  }
                >
                  <Icon />
                </Segment>
              ))}
            </Segments>
          </Row>
        </Section>
      ) : null}
      <Section title={messages.layout}>
        <LengthField
          label={messages.padding}
          value={style.padding}
          onChange={(value) => onChange({ padding: value })}
        />
        <LengthField
          label={messages.gap}
          value={style.gap}
          onChange={(value) => onChange({ gap: value })}
        />
        <LengthField
          label={messages.radius}
          value={style["border-radius"]}
          onChange={(value) => onChange({ "border-radius": value })}
        />
      </Section>
    </div>
  )
}

/** A weight as a number, where the source names it. */
function normalWeight(weight: string | undefined): string | undefined {
  if (weight === "normal") return "400"
  if (weight === "bold") return "700"
  return weight
}

function Section({ title, children }: { readonly title: string; readonly children: ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <h3 className="m-0 text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">
        {title}
      </h3>
      {children}
    </section>
  )
}

function Row({ label, children }: { readonly label: string; readonly children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-xs text-foreground/80">{label}</span>
      {children}
    </div>
  )
}

/** A color: a swatch row, and the value as text, set as it is left or on Enter. */
function ColorField({
  label,
  value,
  onChange,
}: {
  readonly label: string
  readonly value: string | undefined
  readonly onChange: (value: string | null) => boolean
}) {
  const messages = useArtifactMessages().canvas.edit
  return (
    <div className="flex flex-col gap-1.5">
      <ValueField label={label} value={value} onChange={onChange} swatch={value} />
      <div className="flex flex-wrap gap-1" role="group" aria-label={label}>
        {SWATCHES.map((color) => (
          <button
            key={color}
            type="button"
            aria-label={messages.swatch(color)}
            title={color}
            aria-pressed={value?.toLowerCase() === color}
            onClick={() => onChange(color)}
            className="flex size-5 items-center justify-center rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <span
              aria-hidden="true"
              className={cn(
                "size-4 rounded-full ring-1 ring-[color-mix(in_oklab,var(--foreground)_16%,transparent)]",
                value?.toLowerCase() === color &&
                  "ring-2 ring-foreground ring-offset-1 ring-offset-popover"
              )}
              style={{ background: color }}
            />
          </button>
        ))}
      </div>
    </div>
  )
}

/** A length: a number alone is in pixels. */
function LengthField({
  label,
  value,
  onChange,
}: {
  readonly label: string
  readonly value: string | undefined
  readonly onChange: (value: string | null) => boolean
}) {
  return (
    <ValueField
      label={label}
      value={value}
      onChange={(next) =>
        onChange(next !== null && /^\d+(\.\d+)?$/.test(next) ? `${next}px` : next)
      }
    />
  )
}

/**
 * A property's value as text: committed as it is left or on Enter, an empty one taking it out of
 * the style. One the board refuses stays, marked, for the reader to correct.
 */
function ValueField({
  label,
  value,
  onChange,
  swatch,
}: {
  readonly label: string
  readonly value: string | undefined
  readonly onChange: (value: string | null) => boolean
  readonly swatch?: string
}) {
  const messages = useArtifactMessages().canvas.edit
  const id = useId()
  const [text, setText] = useState(value ?? "")
  const [invalid, setInvalid] = useState(false)
  useEffect(() => {
    setText(value ?? "")
    setInvalid(false)
  }, [value])

  const commit = () => {
    const next = text.trim()
    if (next === (value ?? "")) return
    setInvalid(!onChange(next === "" ? null : next))
  }

  return (
    <div className="flex items-center justify-between gap-3">
      <label htmlFor={id} className="text-xs text-foreground/80">
        {label}
      </label>
      <div className="flex items-center gap-1">
        <div
          className={cn(
            "flex h-7 w-[8.5rem] items-center gap-1.5 rounded-md border bg-background px-1.5 text-xs focus-within:ring-2 focus-within:ring-ring",
            invalid ? "border-destructive" : "border-border"
          )}
        >
          {swatch !== undefined ? (
            <span
              aria-hidden="true"
              className="size-3.5 shrink-0 rounded-[4px] ring-1 ring-[color-mix(in_oklab,var(--foreground)_16%,transparent)]"
              style={{ background: swatch || "transparent" }}
            />
          ) : null}
          <input
            id={id}
            value={text}
            placeholder={messages.inherited}
            aria-invalid={invalid || undefined}
            spellCheck={false}
            onChange={(event) => setText(event.target.value)}
            onBlur={commit}
            onKeyDown={(event) => {
              event.stopPropagation()
              if (event.key === "Enter") commit()
            }}
            className="h-full min-w-0 flex-1 bg-transparent font-mono text-[11px] outline-none placeholder:font-sans placeholder:text-muted-foreground/70"
          />
        </div>
        <button
          type="button"
          aria-label={messages.reset(label)}
          title={messages.reset(label)}
          disabled={value === undefined}
          onClick={() => onChange(null)}
          className="flex size-6 items-center justify-center rounded-md text-muted-foreground outline-none hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-30 [&_svg]:size-3.5"
        >
          <RotateCcw />
        </button>
      </div>
      {invalid ? (
        <span role="alert" className="sr-only">
          {messages.invalid}
        </span>
      ) : null}
    </div>
  )
}

function Segments({ label, children }: { readonly label: string; readonly children: ReactNode }) {
  return (
    <div role="group" aria-label={label} className="flex items-center rounded-lg bg-muted/70 p-0.5">
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
        "flex h-6 min-w-7 items-center justify-center rounded-md px-1.5 text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring [&_svg]:size-3.5",
        pressed && "bg-background text-foreground shadow-sm"
      )}
    >
      {children}
    </button>
  )
}

/** An image the reader may show in its place: one the canvas holds, pictured when it can be. */
export interface CanvasImage {
  readonly path: string
  readonly url?: string
}

/**
 * An image's picture and description: upload a new picture, or pick one the canvas holds; the
 * description is set as it is left.
 */
export function ImagePanel({
  current,
  alt,
  images,
  uploading,
  failure,
  onUpload,
  onPick,
  onAlt,
}: {
  /** The path of the picture it shows now, when it is one of the canvas's. */
  readonly current: string | null
  readonly alt: string
  readonly images: readonly CanvasImage[]
  readonly uploading: boolean
  readonly failure: string | null
  readonly onUpload: (file: File) => void
  readonly onPick: (path: string) => void
  readonly onAlt: (alt: string) => void
}) {
  const messages = useArtifactMessages().canvas.edit
  const input = useRef<HTMLInputElement | null>(null)
  const altId = useId()
  const [text, setText] = useState(alt)
  useEffect(() => setText(alt), [alt])
  const others = images.filter((image) => image.path !== current)

  return (
    <div className="flex w-[17rem] flex-col gap-3" data-board-tools="">
      <input
        ref={input}
        type="file"
        accept="image/*"
        className="sr-only"
        tabIndex={-1}
        aria-hidden="true"
        onChange={(event) => {
          const file = event.target.files?.[0]
          event.target.value = ""
          if (file) onUpload(file)
        }}
      />
      <button
        type="button"
        disabled={uploading}
        onClick={() => input.current?.click()}
        className="flex h-9 items-center justify-center gap-2 rounded-lg border border-dashed border-border bg-muted/40 text-sm font-medium text-foreground outline-none transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60 [&_svg]:size-4"
      >
        {uploading ? (
          <LoaderCircle className="animate-spin motion-reduce:animate-none" aria-hidden="true" />
        ) : (
          <ImageUp aria-hidden="true" />
        )}
        {uploading ? messages.uploading : messages.upload}
      </button>
      {failure ? (
        <p role="alert" className="m-0 text-xs text-destructive">
          {failure}
        </p>
      ) : null}

      <section className="flex flex-col gap-2">
        <h3 className="m-0 text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">
          {messages.fromCanvas}
        </h3>
        {others.length > 0 ? (
          <div className="grid max-h-40 grid-cols-4 gap-1.5 overflow-y-auto p-0.5">
            {others.map((image) => (
              <button
                key={image.path}
                type="button"
                title={image.path}
                aria-label={image.path}
                onClick={() => onPick(image.path)}
                className="flex aspect-square items-center justify-center overflow-hidden rounded-md bg-muted outline-none ring-1 ring-border transition-shadow hover:ring-2 hover:ring-primary focus-visible:ring-2 focus-visible:ring-ring"
              >
                {image.url ? (
                  <img
                    src={image.url}
                    alt=""
                    loading="lazy"
                    className="size-full object-cover"
                    draggable={false}
                  />
                ) : (
                  <ImageIcon className="size-4 text-muted-foreground" aria-hidden="true" />
                )}
              </button>
            ))}
          </div>
        ) : (
          <p className="m-0 text-xs text-muted-foreground">{messages.noImages}</p>
        )}
      </section>

      <div className="flex flex-col gap-1.5">
        <label htmlFor={altId} className="text-xs text-foreground/80">
          {messages.description}
        </label>
        <input
          id={altId}
          value={text}
          placeholder={messages.descriptionPlaceholder}
          onChange={(event) => setText(event.target.value)}
          onBlur={() => {
            if (text !== alt) onAlt(text)
          }}
          onKeyDown={(event) => {
            event.stopPropagation()
            if (event.key === "Enter" && text !== alt) onAlt(text)
          }}
          className="h-8 rounded-md border border-border bg-background px-2 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring"
        />
      </div>
    </div>
  )
}
