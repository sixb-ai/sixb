import type { AgentContextInput } from "@sixb/core/agents/context"
import { Button } from "@sixb/ui/components"
import { cn } from "@sixb/ui/lib/utils"
import { ChevronRight, Maximize2, MessageSquareText, Minimize2 } from "lucide-react"
import {
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react"
import { AgentPanel } from "./AgentPanel"
import {
  AGENT_SURFACE_STATE_EVENT,
  type AgentSurfaceMode,
  type AgentSurfaceSessionState,
  type AgentSurfaceStateDetail,
  agentSurfaceSessionStorageKey,
  clampAgentSurfaceWidth,
  DEFAULT_AGENT_SURFACE_WIDTH,
  MAX_AGENT_SURFACE_WIDTH,
  MIN_AGENT_SURFACE_WIDTH,
  parseAgentSurfaceSessionState,
} from "./agent-surface-state"

export type { AgentSurfaceMode } from "./agent-surface-state"

export interface AgentSurfaceProps {
  /** Pin the surface to one agent. Omit to let the user choose among registered agents. */
  readonly agentId?: string
  /** Controlled presentation. Omit to persist an independent value in this browser tab. */
  readonly mode?: AgentSurfaceMode
  readonly defaultMode?: AgentSurfaceMode
  readonly onModeChange?: (mode: AgentSurfaceMode) => void
  /** Present this same session as the host route's full-page conversation. */
  readonly fullPage?: boolean
  /** Ask the host to navigate from the dock to its full-page conversation route. */
  readonly onRequestFullPage?: () => void
  /** Ask the host to leave its full-page conversation route while keeping the dock open. */
  readonly onRequestDock?: () => void
  readonly title?: string
  readonly launcherLabel?: string
  readonly context?: readonly AgentContextInput[]
  /** Controlled thread. The latest value is still remembered for a later dock transition. */
  readonly threadId?: string | null
  readonly defaultThreadId?: string | null
  readonly onThreadChange?: (threadId: string | null) => void
  /** Offer an explicit full-page view for the selected thread. */
  readonly onExpandThread?: (threadId: string) => void
  /** Controlled dock width. Numeric values are pixels. */
  readonly dockWidth?: CSSProperties["width"]
  readonly defaultDockWidth?: number
  readonly onDockWidthChange?: (width: number) => void
  readonly minDockWidth?: number
  readonly maxDockWidth?: number
  readonly resizable?: boolean
  /** sessionStorage key override. Pass false to disable per-tab persistence. */
  readonly persistenceKey?: string | false
  readonly className?: string
  readonly panelClassName?: string
}

/**
 * One continuously mounted agent session that can fill the page, sit beside an app, or collapse.
 * Its uncontrolled mode, width, and selected thread are session-scoped so refreshes preserve them
 * without coupling separate browser tabs or the host application's URL.
 */
export function AgentSurface({
  agentId,
  mode,
  defaultMode = "dock",
  onModeChange,
  fullPage = false,
  onRequestFullPage,
  onRequestDock,
  title = "Assistant",
  launcherLabel = "Open assistant",
  context,
  threadId,
  defaultThreadId = null,
  onThreadChange,
  onExpandThread,
  dockWidth,
  defaultDockWidth = DEFAULT_AGENT_SURFACE_WIDTH,
  onDockWidthChange,
  minDockWidth = MIN_AGENT_SURFACE_WIDTH,
  maxDockWidth = MAX_AGENT_SURFACE_WIDTH,
  resizable = true,
  persistenceKey,
  className,
  panelClassName,
}: AgentSurfaceProps) {
  const minimumWidth = Math.min(minDockWidth, maxDockWidth)
  const maximumWidth = Math.max(minDockWidth, maxDockWidth)
  const surfaceScope = agentId ?? "agents"
  const storageKey = agentSurfaceSessionStorageKey(surfaceScope, persistenceKey)
  const defaults: AgentSurfaceSessionState = {
    mode: defaultMode,
    dockWidth: clampAgentSurfaceWidth(defaultDockWidth, minimumWidth, maximumWidth),
    threadId: defaultThreadId,
  }
  const [sessionState, setSessionState] = useState(() =>
    readSessionState(storageKey, defaults, minimumWidth, maximumWidth)
  )
  const [documentHost, setDocumentHost] = useState<HTMLDivElement | null>(null)
  const [resizing, setResizing] = useState(false)
  const resizeStart = useRef<{
    readonly pointerId: number
    readonly clientX: number
    readonly width: number
  } | null>(null)
  const updateSessionState = useCallback(
    (update: (current: AgentSurfaceSessionState) => AgentSurfaceSessionState) => {
      setSessionState((current) => {
        const next = update(current)
        writeSessionState(storageKey, next)
        return next
      })
    },
    [storageKey]
  )

  useEffect(() => {
    if (!storageKey || typeof window === "undefined") return

    const receiveState = (event: Event) => {
      const detail = (event as CustomEvent<AgentSurfaceStateDetail>).detail
      if (detail?.agentId !== surfaceScope || detail.storageKey !== storageKey) return
      setSessionState(detail.state)
    }

    window.addEventListener(AGENT_SURFACE_STATE_EVENT, receiveState)
    return () => window.removeEventListener(AGENT_SURFACE_STATE_EVENT, receiveState)
  }, [storageKey, surfaceScope])

  const currentMode = mode ?? sessionState.mode
  const full = fullPage
  const currentThreadId = threadId === undefined ? sessionState.threadId : threadId
  const currentDockWidth = dockWidth ?? sessionState.dockWidth
  const numericDockWidth =
    typeof currentDockWidth === "number" ? currentDockWidth : sessionState.dockWidth
  const visible = full || currentMode !== "collapsed"
  const presentation = full ? "full" : currentMode
  const dockWidthValue =
    typeof currentDockWidth === "number" ? `${currentDockWidth}px` : currentDockWidth
  const surfaceStyle = { "--agent-surface-width": dockWidthValue } as CSSProperties

  const changeMode = useCallback(
    (nextMode: AgentSurfaceMode) => {
      if (mode === undefined) {
        updateSessionState((current) => ({ ...current, mode: nextMode }))
      }
      onModeChange?.(nextMode)
    },
    [mode, onModeChange, updateSessionState]
  )

  const changeThread = useCallback(
    (nextThreadId: string | null) => {
      updateSessionState((current) =>
        current.threadId === nextThreadId ? current : { ...current, threadId: nextThreadId }
      )
      onThreadChange?.(nextThreadId)
    },
    [onThreadChange, updateSessionState]
  )

  useEffect(() => {
    if (threadId === undefined || sessionState.threadId === threadId) return
    updateSessionState((current) => ({ ...current, threadId }))
  }, [sessionState.threadId, threadId, updateSessionState])

  useEffect(() => {
    if (!full || sessionState.mode === "dock") return
    updateSessionState((current) => ({ ...current, mode: "dock" }))
  }, [full, sessionState.mode, updateSessionState])

  const changeDockWidth = useCallback(
    (nextWidth: number) => {
      const viewportMaximum =
        typeof window === "undefined"
          ? maximumWidth
          : Math.max(minimumWidth, Math.min(maximumWidth, window.innerWidth - minimumWidth))
      const clamped = clampAgentSurfaceWidth(nextWidth, minimumWidth, viewportMaximum)
      if (dockWidth === undefined) {
        updateSessionState((current) => ({ ...current, dockWidth: clamped }))
      }
      onDockWidthChange?.(clamped)
    },
    [dockWidth, maximumWidth, minimumWidth, onDockWidthChange, updateSessionState]
  )

  function startResize(event: PointerEvent<HTMLDivElement>) {
    if (event.button !== 0) return
    event.preventDefault()
    event.currentTarget.setPointerCapture(event.pointerId)
    resizeStart.current = {
      pointerId: event.pointerId,
      clientX: event.clientX,
      width: numericDockWidth,
    }
    setResizing(true)
  }

  function continueResize(event: PointerEvent<HTMLDivElement>) {
    const start = resizeStart.current
    if (!start || start.pointerId !== event.pointerId) return
    changeDockWidth(start.width + start.clientX - event.clientX)
  }

  function finishResize(event: PointerEvent<HTMLDivElement>) {
    if (resizeStart.current?.pointerId !== event.pointerId) return
    resizeStart.current = null
    setResizing(false)
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
  }

  function resizeWithKeyboard(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return
    event.preventDefault()
    const step = event.shiftKey ? 32 : 16
    changeDockWidth(numericDockWidth + (event.key === "ArrowLeft" ? step : -step))
  }

  return (
    <>
      {!visible ? (
        <Button
          type="button"
          className="fixed right-5 bottom-5 z-40 h-11 rounded-full px-4 shadow-lg max-sm:right-3 max-sm:bottom-3"
          aria-label={launcherLabel}
          onClick={() => changeMode("dock")}
        >
          <MessageSquareText className="size-4" />
          {launcherLabel}
        </Button>
      ) : null}

      <div
        ref={setDocumentHost}
        data-agent-document-host=""
        aria-hidden={!visible}
        inert={!visible}
        className={cn(
          "pointer-events-none fixed inset-y-3 left-3 z-40 max-sm:hidden",
          (!visible || full) && "hidden"
        )}
        style={{ right: `calc(${dockWidthValue} + 0.75rem)` }}
      />

      <aside
        data-agent-surface={presentation}
        data-agent-surface-resizing={resizing ? "" : undefined}
        aria-label={title}
        aria-hidden={!visible}
        inert={!visible}
        style={surfaceStyle}
        className={cn(
          "shrink-0 overflow-hidden bg-background transition-[width,border-color] duration-300 ease-out",
          full ? "absolute inset-0 z-40 h-full min-w-0 w-full" : "relative h-svh",
          resizing && "select-none transition-none",
          !visible && "w-0 border-l border-transparent",
          visible &&
            !full &&
            "w-[var(--agent-surface-width)] border-l border-border max-sm:fixed max-sm:inset-y-0 max-sm:right-0 max-sm:z-50 max-sm:w-screen",
          className
        )}
      >
        {visible && !full && resizable ? (
          <div
            role="separator"
            aria-label="Resize assistant"
            aria-orientation="vertical"
            aria-valuemin={minimumWidth}
            aria-valuemax={maximumWidth}
            aria-valuenow={Math.round(numericDockWidth)}
            tabIndex={0}
            onPointerDown={startResize}
            onPointerMove={continueResize}
            onPointerUp={finishResize}
            onPointerCancel={finishResize}
            onKeyDown={resizeWithKeyboard}
            className="absolute inset-y-0 left-0 z-30 w-1 cursor-ew-resize touch-none bg-transparent outline-none transition-colors hover:bg-ring/40 focus-visible:bg-ring/60 max-sm:hidden"
          />
        ) : null}

        <div
          className={cn(
            "relative flex h-full min-w-0 flex-col",
            full ? "w-full" : "w-[var(--agent-surface-width)] max-sm:w-screen"
          )}
        >
          {!full ? (
            <Button
              type="button"
              variant="ghost"
              size="icon-lg"
              aria-label="Collapse assistant"
              onClick={() => changeMode("collapsed")}
              className="absolute top-0.5 left-1.5 z-20 bg-background/90 backdrop-blur-sm [&_svg]:size-5"
            >
              <ChevronRight />
            </Button>
          ) : null}

          <AgentPanel
            agentId={agentId}
            compact={!full}
            context={context}
            threadId={currentThreadId}
            onThreadChange={changeThread}
            conversationHeaderActions={
              full ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-lg"
                  aria-label="Move assistant to side panel"
                  onClick={() => {
                    changeMode("dock")
                    onRequestDock?.()
                  }}
                  className="[&_svg]:size-5"
                >
                  <Minimize2 />
                </Button>
              ) : onRequestFullPage || (onExpandThread && currentThreadId) ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-lg"
                  aria-label="Expand conversation"
                  onClick={() => {
                    if (onExpandThread && currentThreadId) onExpandThread(currentThreadId)
                    else onRequestFullPage?.()
                  }}
                  className="[&_svg]:size-5"
                >
                  <Maximize2 />
                </Button>
              ) : null
            }
            documentPreviewHost={full ? null : documentHost}
            className={cn(
              "min-h-0 flex-1",
              !full && "[&_[data-agent-conversation-header]]:pl-12",
              panelClassName
            )}
          />
        </div>
      </aside>
    </>
  )
}

function readSessionState(
  storageKey: string | null,
  defaults: AgentSurfaceSessionState,
  minimumWidth: number,
  maximumWidth: number
): AgentSurfaceSessionState {
  if (!storageKey || typeof window === "undefined") return defaults
  try {
    return parseAgentSurfaceSessionState(
      window.sessionStorage.getItem(storageKey),
      defaults,
      minimumWidth,
      maximumWidth
    )
  } catch {
    return defaults
  }
}

function writeSessionState(storageKey: string | null, state: AgentSurfaceSessionState) {
  if (!storageKey || typeof window === "undefined") return
  try {
    window.sessionStorage.setItem(storageKey, JSON.stringify(state))
  } catch {
    // Storage may be unavailable in restricted browser contexts; in-memory state still works.
  }
}
