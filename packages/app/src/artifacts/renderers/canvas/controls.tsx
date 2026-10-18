import { Panel, useReactFlow, useStore } from "@xyflow/react"
import { Maximize, Minus, Plus } from "lucide-react"
import type { ReactNode } from "react"
import { useArtifactMessages } from "../../messages"

/** How long the board takes to move when a control moves it. */
const DURATION = 220

/**
 * The board's zoom controls, floating in its corner: out, the zoom as a percent, which goes to 100%
 * when pressed, in, and fit to everything. Each stays a comfortable target on a phone.
 */
export function CanvasControls({ padding }: { readonly padding: number }) {
  const messages = useArtifactMessages().canvas
  const { zoomIn, zoomOut, zoomTo, fitView } = useReactFlow()
  const zoom = useStore((state) => state.transform[2])
  return (
    <Panel position="bottom-left" className="!m-3">
      <div className="flex items-center gap-0.5 rounded-xl border border-border bg-background/90 p-1 shadow-[0_1px_2px_rgb(0_0_0/0.06),0_8px_24px_-12px_rgb(0_0_0/0.25)] backdrop-blur">
        <Control label={messages.zoomOut} onClick={() => zoomOut({ duration: DURATION })}>
          <Minus className="size-4" aria-hidden="true" />
        </Control>
        <button
          type="button"
          title={messages.actualSize}
          onClick={() => void zoomTo(1, { duration: DURATION })}
          className="h-8 w-12 rounded-lg text-center text-xs font-medium text-muted-foreground tabular-nums outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
        >
          <span aria-live="polite">{messages.zoom(Math.round(zoom * 100))}</span>
          <span className="sr-only">, {messages.actualSize}</span>
        </button>
        <Control label={messages.zoomIn} onClick={() => zoomIn({ duration: DURATION })}>
          <Plus className="size-4" aria-hidden="true" />
        </Control>
        <span className="mx-1 h-5 w-px bg-border" aria-hidden="true" />
        <Control
          label={messages.fitView}
          onClick={() => void fitView({ padding, duration: DURATION })}
          wide
        >
          <Maximize className="size-3.5" aria-hidden="true" />
          <span className="text-xs font-medium">{messages.fit}</span>
        </Control>
      </div>
    </Panel>
  )
}

function Control({
  label,
  onClick,
  wide = false,
  children,
}: {
  readonly label: string
  readonly onClick: () => void
  readonly wide?: boolean
  readonly children: ReactNode
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className={
        wide
          ? "flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-muted-foreground outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
          : "flex size-8 items-center justify-center rounded-lg text-muted-foreground outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
      }
    >
      {children}
    </button>
  )
}
