import type { AgentContextInput } from "@sixb/core/agents/context"
import { cn } from "@sixb/ui/lib/utils"
import { type ReactNode, useCallback, useState } from "react"
import { AgentChat } from "./agent-chat"
import { useRegisteredAgentContext } from "./agent-context-provider"

export interface AgentPanelProps {
  /** Omitted uses AgentContextProvider; provided is the complete controlled ambient list. */
  readonly context?: readonly AgentContextInput[]
  /** Controlled thread id. Omit to let the panel own its current thread. */
  readonly threadId?: string | null
  readonly defaultThreadId?: string | null
  readonly onThreadChange?: (threadId: string | null) => void
  readonly onNewThread?: () => void
  /** Open the page of every conversation, from the header's button. */
  readonly onOpenThreads?: () => void
  /** Optional modeless artifact canvas owned by an enclosing application shell. */
  readonly artifactHost?: HTMLElement | null
  /** Keep artifacts beside the chat on desktop instead of opening a modal. */
  readonly splitArtifacts?: boolean
  readonly conversationHeaderActions?: ReactNode
  readonly composerPlaceholder?: string
  /**
   * A microphone in the composer when the project declares a transcription model and the reader
   * may call it. False hides it.
   */
  readonly dictation?: boolean
  readonly compact?: boolean
  readonly className?: string
  /** Centered content for an empty conversation. Omit for the agent identity; null hides it. */
  readonly welcomeContent?: ReactNode
}

/** Embeddable chat that never reads or changes the host application's route. */
export function AgentPanel({
  context,
  threadId: controlledThreadId,
  defaultThreadId = null,
  onThreadChange,
  onNewThread,
  onOpenThreads,
  artifactHost,
  splitArtifacts,
  conversationHeaderActions,
  composerPlaceholder,
  dictation,
  compact = true,
  className,
  welcomeContent,
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
      artifactHost={artifactHost}
      splitArtifacts={splitArtifacts}
      conversationHeaderActions={conversationHeaderActions}
      composerPlaceholder={composerPlaceholder}
      dictation={dictation}
      welcomeContent={welcomeContent}
      onNavigateHome={() => {
        changeThread(null)
        onNewThread?.()
      }}
      onNavigateThread={changeThread}
      onOpenThreads={onOpenThreads}
      className={cn("min-h-0 overflow-hidden bg-background", className)}
    />
  )
}
