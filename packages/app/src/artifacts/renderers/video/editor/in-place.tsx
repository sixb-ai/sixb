import type { FrameRect } from "@sixb/core/artifacts"
import { cn } from "@sixb/ui/lib/utils"
import { useEffect, useRef, useState } from "react"
import { useArtifactMessages } from "../../../messages"

// Words typed over where they show: the paused picture marks the text the reader clicked, and a
// field under it, or over it near the foot, takes their words. Enter keeps them, Shift and Enter
// breaks the line, Escape or a click elsewhere leaves them as they were.

export interface InPlaceText {
  /** The file its words are in, and its ref among the file's texts. */
  readonly file: string
  readonly ref: string
  readonly text: string
  /** Where it shows, in fractions of the picture. */
  readonly rect: FrameRect
}

export function InPlaceEditor({
  target,
  onCommit,
  onClose,
}: {
  readonly target: InPlaceText
  readonly onCommit: (text: string) => void
  readonly onClose: () => void
}) {
  const messages = useArtifactMessages().videoEditor
  const field = useRef<HTMLTextAreaElement | null>(null)
  const [text, setText] = useState(target.text)
  useEffect(() => {
    field.current?.focus()
    field.current?.select()
  }, [])

  const { rect } = target
  const below = rect.y + rect.height < 0.72
  const done = useRef(false)
  const finish = (keep: boolean) => {
    if (done.current) return
    done.current = true
    if (keep && text.trim() !== "" && text.trim() !== target.text) onCommit(text)
    onClose()
  }

  return (
    <>
      <span
        aria-hidden="true"
        className="pointer-events-none absolute rounded-md ring-2 ring-primary ring-offset-2 ring-offset-black/40"
        style={{
          left: `${rect.x * 100}%`,
          top: `${rect.y * 100}%`,
          width: `${rect.width * 100}%`,
          height: `${rect.height * 100}%`,
        }}
      />
      <div
        className={cn(
          "absolute z-20 w-72 max-w-[90%] rounded-xl border border-border bg-background p-2 shadow-xl motion-safe:animate-in motion-safe:fade-in-0",
          below ? "mt-2" : "-translate-y-full"
        )}
        style={{
          left: `clamp(0px, ${rect.x * 100}%, calc(100% - 18rem))`,
          top: below ? `${(rect.y + rect.height) * 100}%` : `calc(${rect.y * 100}% - 0.5rem)`,
        }}
        onPointerUp={(event) => event.stopPropagation()}
      >
        <textarea
          ref={field}
          value={text}
          rows={Math.min(4, Math.max(1, Math.ceil(text.length / 34)))}
          aria-label={messages.text}
          onChange={(event) => setText(event.currentTarget.value)}
          onKeyDown={(event) => {
            event.stopPropagation()
            if (event.key === "Escape") finish(false)
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault()
              finish(true)
            }
          }}
          onBlur={() => finish(true)}
          className="w-full resize-none rounded-md border border-input bg-background px-2.5 py-1.5 text-sm text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
        />
        <p className="m-0 mt-1 px-1 text-[11px] text-muted-foreground">{messages.inPlaceHint}</p>
      </div>
    </>
  )
}
