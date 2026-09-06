import type { AgentContextInput } from "@sixb/core/agents/context"
import { cn } from "@sixb/ui/lib/utils"
import { type ReactNode, useCallback, useEffect, useRef, useState } from "react"
import { AgentChat } from "./AgentChat"
import { useRegisteredAgentContext } from "./AgentContextProvider"

export interface AgentPanelProps {
  /** Pin the panel to one agent. Omit to let the user choose among registered agents. */
  readonly agentId?: string
  /** Omitted uses AgentContextProvider; provided is the complete controlled ambient list. */
  readonly context?: readonly AgentContextInput[]
  /** Controlled thread id. Omit to let the panel own its current thread. */
  readonly threadId?: string | null
  readonly defaultThreadId?: string | null
  readonly onThreadChange?: (threadId: string | null) => void
  readonly onBackHome?: () => void
  readonly onNewThread?: () => void
  /** Optional modeless document canvas owned by an enclosing application shell. */
  readonly documentPreviewHost?: HTMLElement | null
  /** Keep documents beside the chat on desktop instead of opening a modal. */
  readonly splitDocumentPreview?: boolean
  /** Optional branded content above the centered composer in a new draft. */
  readonly emptyStateHeader?: ReactNode
  /** Optional shortcuts below the centered composer in a new draft. */
  readonly emptyStateFooter?: ReactNode
  readonly centerEmptyState?: boolean
  readonly hideHeaderOnEmpty?: boolean
  /** A labeled history action shown without restoring the full empty-state header. */
  readonly emptyStateThreadHistoryLabel?: string
  readonly conversationHeaderActions?: ReactNode
  readonly composerPlaceholder?: string
  readonly compact?: boolean
  readonly className?: string
}

/** Embeddable chat that never reads or changes the host application's route. */
export function AgentPanel({
  agentId,
  context,
  threadId: controlledThreadId,
  defaultThreadId = null,
  onThreadChange,
  onBackHome,
  onNewThread,
  documentPreviewHost,
  splitDocumentPreview,
  emptyStateHeader,
  emptyStateFooter,
  centerEmptyState,
  hideHeaderOnEmpty,
  emptyStateThreadHistoryLabel,
  conversationHeaderActions,
  composerPlaceholder,
  compact = true,
  className,
}: AgentPanelProps) {
  const registeredContext = useRegisteredAgentContext()
  const ambientContext = context === undefined ? registeredContext : context
  const controlled = controlledThreadId !== undefined
  const [localThreadId, setLocalThreadId] = useState<string | null>(defaultThreadId)
  const [localDraftAgentId, setLocalDraftAgentId] = useState<string | null>(agentId ?? null)
  const previousAgentIdRef = useRef(agentId)
  const threadId = controlled ? controlledThreadId : localThreadId

  const changeThread = useCallback(
    (nextThreadId: string | null) => {
      if (!controlled) setLocalThreadId(nextThreadId)
      if (nextThreadId) setLocalDraftAgentId(null)
      onThreadChange?.(nextThreadId)
    },
    [controlled, onThreadChange]
  )

  // An uncontrolled panel starts a clean conversation when its pinned agent changes. Controlled
  // callers own that decision and can intentionally retain or replace their thread id.
  useEffect(() => {
    if (previousAgentIdRef.current === agentId) return
    previousAgentIdRef.current = agentId
    if (!controlled) {
      setLocalThreadId(null)
      setLocalDraftAgentId(agentId ?? null)
      onThreadChange?.(null)
    }
  }, [agentId, controlled, onThreadChange])

  const startDraft = (nextAgentId: string) => {
    setLocalDraftAgentId(nextAgentId)
    changeThread(null)
    onNewThread?.()
  }

  const showHome = () => {
    setLocalDraftAgentId(agentId ?? null)
    changeThread(null)
    onBackHome?.()
  }

  return (
    <AgentChat
      pinnedAgentId={agentId}
      threadId={threadId}
      draftAgentId={threadId === null ? (agentId ?? localDraftAgentId) : null}
      ambientContext={ambientContext}
      compact={compact}
      documentPreviewHost={documentPreviewHost}
      splitDocumentPreview={splitDocumentPreview}
      emptyStateHeader={emptyStateHeader}
      emptyStateFooter={emptyStateFooter}
      centerEmptyState={centerEmptyState}
      hideHeaderOnEmpty={hideHeaderOnEmpty}
      emptyStateThreadHistoryLabel={emptyStateThreadHistoryLabel}
      conversationHeaderActions={conversationHeaderActions}
      composerPlaceholder={composerPlaceholder}
      onNavigateHome={showHome}
      onNavigateDraft={startDraft}
      onNavigateThread={changeThread}
      className={cn("min-h-0 overflow-hidden bg-background", className)}
    />
  )
}
