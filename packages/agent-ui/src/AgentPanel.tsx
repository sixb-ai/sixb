import type { AgentContextInput } from "@sixb/core/agents/context"
import { cn } from "@sixb/ui/lib/utils"
import { type ReactNode, useCallback, useState } from "react"
import { AgentChat } from "./AgentChat"
import { useRegisteredAgentContext } from "./AgentContextProvider"
import type { AgentDocumentPreviewRenderer } from "./document-preview/types"

export interface AgentPanelProps {
  /** Omitted uses AgentContextProvider; provided is the complete controlled ambient list. */
  readonly context?: readonly AgentContextInput[]
  /** Controlled thread id. Omit to let the panel own its current thread. */
  readonly threadId?: string | null
  readonly defaultThreadId?: string | null
  readonly onThreadChange?: (threadId: string | null) => void
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
  /** Centered content for an empty conversation. Omit for the agent identity; null hides it. */
  readonly welcomeContent?: ReactNode
  /** Additional file viewers supplied by the host application. */
  readonly documentPreviewRenderers?: readonly AgentDocumentPreviewRenderer[]
}

/** Embeddable chat that never reads or changes the host application's route. */
export function AgentPanel({
  context,
  threadId: controlledThreadId,
  defaultThreadId = null,
  onThreadChange,
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
  welcomeContent,
  documentPreviewRenderers,
}: AgentPanelProps) {
  const registeredContext = useRegisteredAgentContext()
  const ambientContext = context === undefined ? registeredContext : context
  const controlled = controlledThreadId !== undefined
  const [localThreadId, setLocalThreadId] = useState<string | null>(defaultThreadId)
  const threadId = controlled ? controlledThreadId : localThreadId

  const changeThread = useCallback(
    (nextThreadId: string | null) => {
      if (!controlled) setLocalThreadId(nextThreadId)
      onThreadChange?.(nextThreadId)
    },
    [controlled, onThreadChange]
  )

  return (
    <AgentChat
      threadId={threadId}
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
      welcomeContent={welcomeContent}
      onNavigateHome={() => {
        changeThread(null)
        onNewThread?.()
      }}
      onNavigateThread={changeThread}
      documentPreviewRenderers={documentPreviewRenderers}
      className={cn("min-h-0 overflow-hidden bg-background", className)}
    />
  )
}
