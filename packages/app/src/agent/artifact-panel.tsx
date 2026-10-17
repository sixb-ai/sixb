import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@sixb/ui/components"
import { useIsMobile } from "@sixb/ui/hooks"
import { cn } from "@sixb/ui/lib/utils"
import {
  createContext,
  memo,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from "react"
import { createPortal } from "react-dom"
import { ArtifactReferencesProvider } from "../artifacts/references/references"
import { type ArtifactTarget, type ViewerTarget, viewerTargetKey } from "../artifacts/target"
import { Viewer } from "../artifacts/viewer"
import { artifactHref } from "../pages/routes"
import {
  artifactPanelPresentation,
  readArtifactPanelWidth,
  writeArtifactPanelWidth,
} from "./artifact-panel-state"
import { useAgentMessages } from "./i18n"

export interface ArtifactPanelValue {
  /** What is open, or null when nothing is. */
  readonly openTarget: ViewerTarget | null
  /** The open target's identity, or null when nothing is open. */
  readonly openKey: string | null
  readonly open: (target: ViewerTarget) => void
  readonly close: () => void
}

interface PanelHandle {
  collapse(): void
  expand(): void
  getSize(): { readonly asPercentage: number; readonly inPixels: number }
  isCollapsed(): boolean
  resize(size: number | string): void
}

const ArtifactPanelContext = createContext<ArtifactPanelValue | null>(null)

/** The artifact panel of the conversation around it, when there is one. */
export function useArtifactPanel(): ArtifactPanelValue | null {
  return useContext(ArtifactPanelContext)
}

/**
 * Shows one artifact or file beside the conversation. With `onRouteTargetChange`, an open artifact
 * lives in the page's URL so reloads and shared links land on it; a file stays local, since a
 * message file has no address of its own.
 */
export function ArtifactPanelRoot({
  children,
  compact = false,
  split = false,
  overlayHost,
  scopeKey,
  routeTarget = null,
  onRouteTargetChange,
}: {
  readonly children: ReactNode
  readonly compact?: boolean
  /** Use the resizable panel beside the conversation even when compact. */
  readonly split?: boolean
  /** Where the dock's canvas goes, beside it over the app. */
  readonly overlayHost?: HTMLElement | null
  /** The conversation; a different one starts with nothing open. */
  readonly scopeKey: string
  readonly routeTarget?: ArtifactTarget | null
  readonly onRouteTargetChange?: (target: ArtifactTarget | null) => void
}) {
  const messages = useAgentMessages().artifacts
  const idPrefix = useId()
  const [localTarget, setLocalTarget] = useState<ViewerTarget | null>(null)
  const target: ViewerTarget | null = routeTarget ?? localTarget
  // What the reader followed a reference from, so the panel can take them back.
  const [trail, setTrail] = useState<readonly ViewerTarget[]>([])
  const presentation = artifactPanelPresentation({
    compact,
    isMobile: useIsMobile(),
    hasCanvas: Boolean(overlayHost),
    split,
  })
  const [revealCount, reveal] = useReducer((count: number) => count + 1, 0)
  const openerRef = useRef<HTMLElement | null>(null)
  const scopeRef = useRef(scopeKey)

  useLayoutEffect(() => {
    if (scopeRef.current === scopeKey) return
    scopeRef.current = scopeKey
    setLocalTarget(null)
    setTrail([])
    openerRef.current = null
  }, [scopeKey])

  const show = useCallback(
    (next: ViewerTarget) => {
      if (onRouteTargetChange && next.type === "artifact") {
        setLocalTarget(null)
        onRouteTargetChange(next)
      } else {
        setLocalTarget(next)
        if (onRouteTargetChange && routeTarget) onRouteTargetChange(null)
      }
    },
    [onRouteTargetChange, routeTarget]
  )
  const open = useCallback(
    (next: ViewerTarget) => {
      const active = typeof document === "undefined" ? null : document.activeElement
      openerRef.current = active instanceof HTMLElement ? active : null
      setTrail([])
      show(next)
      reveal()
    },
    [show]
  )
  const close = useCallback(() => {
    setLocalTarget(null)
    setTrail([])
    if (onRouteTargetChange && routeTarget) onRouteTargetChange(null)
    const opener = openerRef.current
    openerRef.current = null
    if (opener?.isConnected) queueMicrotask(() => opener.focus())
  }, [onRouteTargetChange, routeTarget])

  const value = useMemo<ArtifactPanelValue>(
    () => ({ openTarget: target, openKey: target ? viewerTargetKey(target) : null, open, close }),
    [target, open, close]
  )
  const viewer = target ? (
    <Viewer
      target={target}
      onTargetChange={show}
      onOpenReference={(next) => {
        setTrail((current) => [...current, target])
        show(next)
      }}
      chrome={{
        onClose: close,
        ...(trail.length > 0
          ? {
              onBack: () => {
                const previous = trail.at(-1)
                setTrail((current) => current.slice(0, -1))
                if (previous) show(previous)
              },
            }
          : {}),
        ...(target.type === "artifact"
          ? {
              fullPageHref: artifactHref(target.artifactId, {
                ...(target.version === undefined ? {} : { version: target.version }),
                ...(target.part ? { part: target.part } : {}),
              }),
            }
          : {}),
      }}
    />
  ) : null

  return (
    <ArtifactPanelContext.Provider value={value}>
      {/* A stable parent keeps composer drafts and scroll position across dock and page. */}
      <ArtifactWorkspace
        idPrefix={idPrefix}
        revealKey={
          presentation === "panel" && target ? `${viewerTargetKey(target)}:${revealCount}` : null
        }
        viewer={presentation === "panel" ? viewer : null}
      >
        {/* An artifact a reply shows or links to opens here, beside the conversation. */}
        <ArtifactReferencesProvider open={open}>{children}</ArtifactReferencesProvider>
      </ArtifactWorkspace>
      <Dialog
        open={presentation === "dialog" && target !== null}
        onOpenChange={(nextOpen) => {
          if (!nextOpen) close()
        }}
      >
        <DialogContent
          showCloseButton={false}
          className="flex h-[calc(100dvh-1rem)] max-h-none w-[calc(100vw-1rem)] max-w-none flex-col gap-0 overflow-hidden rounded-xl p-0 sm:h-[min(88vh,56rem)] sm:w-[min(92vw,72rem)] sm:max-w-[min(92vw,72rem)]"
        >
          <DialogTitle className="sr-only">{messages.dialogTitle}</DialogTitle>
          <DialogDescription className="sr-only">{messages.dialogDescription}</DialogDescription>
          {presentation === "dialog" ? viewer : null}
        </DialogContent>
      </Dialog>
      {presentation === "canvas" && overlayHost && viewer
        ? createPortal(
            <section
              role="dialog"
              aria-modal="false"
              aria-label={messages.dialogTitle}
              aria-describedby={`${idPrefix}-canvas-description`}
              className="pointer-events-auto flex h-full min-h-0 w-full min-w-0 flex-col overflow-hidden rounded-xl border border-border bg-background shadow-2xl motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-right-2 motion-safe:duration-200"
            >
              <p id={`${idPrefix}-canvas-description`} className="sr-only">
                {messages.canvasDescription}
              </p>
              {viewer}
            </section>,
            overlayHost
          )
        : null}
    </ArtifactPanelContext.Provider>
  )
}

// Keep the conversation wrapper stable while the panel opens, closes, or changes target.
const ConversationPane = memo(function ConversationPane({ children }: { children: ReactNode }) {
  return <div className="h-full min-h-0 min-w-0">{children}</div>
})

function ArtifactWorkspace({
  idPrefix,
  revealKey,
  viewer,
  children,
}: {
  readonly idPrefix: string
  /** Changes whenever the panel should show itself: a new target, or the same one asked again. */
  readonly revealKey: string | null
  readonly viewer: ReactNode
  readonly children: ReactNode
}) {
  const open = revealKey !== null
  const panelRef = useRef<PanelHandle | null>(null)
  const sizedRef = useRef(false)

  // biome-ignore lint/correctness/useExhaustiveDependencies: each new reveal key reruns this.
  useEffect(() => {
    const panel = panelRef.current
    if (!panel) return
    if (!open) {
      panel.collapse()
      sizedRef.current = false
      return
    }
    if (!sizedRef.current) {
      sizedRef.current = true
      panel.resize(readArtifactPanelWidth() ?? "50%")
      return
    }
    // Asking for a target again brings back a panel the reader collapsed by dragging the handle.
    if (panel.isCollapsed()) panel.expand()
  }, [open, revealKey])

  const rememberWidth = useCallback(() => {
    const size = panelRef.current?.getSize()
    if (open && size && size.inPixels > 0) writeArtifactPanelWidth(size.inPixels)
  }, [open])

  return (
    <ResizablePanelGroup
      id={`${idPrefix}-workspace`}
      orientation="horizontal"
      onLayoutChanged={rememberWidth}
      className="min-h-0"
    >
      <ResizablePanel id={`${idPrefix}-conversation`} defaultSize="100%" minSize="30%">
        <ConversationPane>{children}</ConversationPane>
      </ResizablePanel>
      <ResizableHandle
        className={cn(
          "bg-transparent transition-opacity before:pointer-events-none before:absolute before:inset-y-0 before:left-1/2 before:w-px before:-translate-x-1/2 before:bg-border/70 before:transition-[width,background-color] before:duration-150 hover:before:w-0.5 hover:before:bg-foreground/25 focus-visible:before:w-0.5 focus-visible:before:bg-ring active:before:w-[3px] active:before:bg-foreground/35",
          !open && "pointer-events-none invisible opacity-0"
        )}
      />
      <ResizablePanel
        id={`${idPrefix}-artifact`}
        defaultSize="0%"
        minSize="20rem"
        maxSize="70%"
        groupResizeBehavior="preserve-pixel-size"
        collapsedSize="0%"
        collapsible
        panelRef={(panel) => {
          panelRef.current = panel
        }}
      >
        <div className="flex h-full min-h-0 min-w-0 flex-col bg-background">
          {open ? viewer : null}
        </div>
      </ResizablePanel>
    </ResizablePanelGroup>
  )
}
