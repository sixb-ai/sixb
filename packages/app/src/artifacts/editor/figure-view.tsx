import { cn } from "@sixb/ui/lib/utils"
import { type NodeViewProps, NodeViewWrapper } from "@tiptap/react"
import { ImageOff } from "lucide-react"
import { createContext, useContext, useEffect, useState } from "react"

/** Where a document's image path is served from, and what an empty caption says. */
export const FigureContext = createContext<{
  readonly source: (src: string) => string | null
  readonly caption: string
}>({ source: () => null, caption: "" })

/**
 * A figure as it reads: the image, and its caption, which is typed into in place. The caption is
 * the image's title, as Markdown keeps it.
 */
export function FigureView({ node, updateAttributes, selected, editor }: NodeViewProps) {
  const { source: resolve, caption: captionPlaceholder } = useContext(FigureContext)
  const src = String(node.attrs.src ?? "")
  const url = /^(https?:|data:image\/)/.test(src) ? src : resolve(src)
  const [caption, setCaption] = useState(String(node.attrs.title ?? ""))
  useEffect(() => setCaption(String(node.attrs.title ?? "")), [node.attrs.title])

  return (
    <NodeViewWrapper as="figure" className={cn("sixb-editor-figure", selected && "is-selected")}>
      <div data-drag-handle="" className="sixb-editor-figure-frame">
        {url ? (
          <img src={url} alt={String(node.attrs.alt ?? "")} draggable={false} />
        ) : (
          <div className="flex aspect-[16/7] flex-col items-center justify-center gap-2 rounded-[var(--radius)] bg-muted text-sm text-muted-foreground">
            <ImageOff className="size-5" />
            <span className="font-mono text-xs">{src}</span>
          </div>
        )}
      </div>
      {editor.isEditable || caption ? (
        <input
          className="sixb-editor-caption"
          value={caption}
          placeholder={captionPlaceholder}
          readOnly={!editor.isEditable}
          aria-label={String(node.attrs.alt ?? "")}
          onChange={(event) => setCaption(event.target.value)}
          onBlur={() => {
            const title = caption.trim() || null
            if (title !== (node.attrs.title ?? null)) updateAttributes({ title })
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault()
              event.currentTarget.blur()
              editor.commands.focus()
            }
          }}
        />
      ) : null}
    </NodeViewWrapper>
  )
}
