import { isArtifactAddress } from "@sixb/core/artifacts"
import { cn } from "@sixb/ui/lib/utils"
import { ImageOff } from "lucide-react"
import { createContext, useContext, useEffect, useState } from "react"
import { ArtifactEmbed } from "../references/references"
import type { Node } from "./core/model"
import type { NodeViewProps } from "./node-views"

/** Where a document's image path is served from, and what an empty caption says. */
export const FigureContext = createContext<{
  readonly source: (src: string) => string | null
  readonly caption: string
}>({ source: () => null, caption: "" })

/**
 * A figure as it reads: the image, and its caption, which is typed into in place. The caption is
 * the image's title, as Markdown keeps it.
 */
export function FigureView({
  node,
  updateAttributes,
  selected,
  editable,
  focusEditor,
}: NodeViewProps) {
  const { source: resolve, caption: captionPlaceholder } = useContext(FigureContext)
  const src = String(node.attrs.src ?? "")
  const embedded = isArtifactAddress(src)
  const url = /^(https?:|data:image\/)/.test(src) ? src : resolve(src)
  const [caption, setCaption] = useState(String(node.attrs.title ?? ""))
  useEffect(() => setCaption(String(node.attrs.title ?? "")), [node.attrs.title])

  return (
    <figure className={cn("sixb-editor-figure", selected && "is-selected")}>
      <div data-drag-handle="" className="sixb-editor-figure-frame">
        {embedded ? (
          // Another artifact, shown as the page shows it; its alt text is its caption.
          <div contentEditable={false}>
            <ArtifactEmbed address={src.trim()} caption={String(node.attrs.alt ?? "")} />
          </div>
        ) : url ? (
          <img src={url} alt={String(node.attrs.alt ?? "")} draggable={false} />
        ) : (
          <div className="flex aspect-[16/7] flex-col items-center justify-center gap-2 rounded-[var(--radius)] bg-muted text-sm text-muted-foreground">
            <ImageOff className="size-5" />
            <span className="font-mono text-xs">{src}</span>
          </div>
        )}
      </div>
      {!embedded && (editable || caption) ? (
        <input
          className="sixb-editor-caption"
          value={caption}
          placeholder={captionPlaceholder}
          readOnly={!editable}
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
              focusEditor()
            }
          }}
        />
      ) : null}
    </figure>
  )
}

/** A figure's DOM: a block the editor picks whole and drags, React drawing inside it. */
export function figureDOM(_node: Node): { dom: HTMLElement; portal: HTMLElement } {
  const dom = document.createElement("div")
  dom.contentEditable = "false"
  dom.draggable = true
  return { dom, portal: dom }
}
