import type { AgentContextInput } from "@sixb/core/agents/context"
import { cn } from "@sixb/ui/lib/utils"
import { useCallback, useState } from "react"
import { AgentChat } from "./AgentChat"
import { useRegisteredAgentContext } from "./AgentContextProvider"

export interface AgentPanelProps {
  /** Omitted uses AgentContextProvider; provided is the complete controlled ambient list. */
  readonly context?: readonly AgentContextInput[]
  /** Controlled thread id. Omit to let the panel own its current thread. */
  readonly threadId?: string | null
  readonly defaultThreadId?: string | null
  readonly onThreadChange?: (threadId: string | null) => void
  readonly className?: string
}

/** Embeddable chat that never reads or changes the host application's route. */
export function AgentPanel({
  context,
  threadId: controlledThreadId,
  defaultThreadId = null,
  onThreadChange,
  className,
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
      compact
      onNavigateHome={() => changeThread(null)}
      onNavigateThread={changeThread}
      className={cn("min-h-0 overflow-hidden bg-background", className)}
    />
  )
}
