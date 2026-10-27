import { useMemo } from "react"
import {
  type AgentConversationMessage,
  type AgentConversationToolPart,
  normalizedParts,
  normalizedTool,
} from "../conversation"
import type { NormalizedPart } from "../parts"
import { useLivePublishes } from "../publish-artifact/use-live-publishes"
import { ProjectToolView, useAgentToolView } from "../tool-views/registry"
import { AssistantBody, BuiltInToolRow } from "./message-parts"

export interface AgentMessageBodyProps {
  /** A reply from `conversation.messages`. A user message draws nothing. */
  readonly message: AgentConversationMessage
}

/**
 * What a reply says, drawn as the built-in chat draws it: its work folded into one line, its text,
 * the tool views placed in the answer, the artifacts it published and what it saved to memory.
 * While the reply streams, its first artifact opens beside the conversation.
 */
export function AgentMessageBody({ message }: AgentMessageBodyProps) {
  const parts = useMemo(() => normalizedParts(message.parts), [message.parts])
  if (message.role !== "assistant") return null

  return (
    <>
      {message.id === null ? <LivePublishes runId={message.runId} parts={parts} /> : null}
      <AssistantBody parts={parts} live={message.status === "streaming"} />
    </>
  )
}

// Apart from the body, so a reply keeps its body's state when its saved copy replaces the stream.
function LivePublishes(live: { readonly runId: string | null; readonly parts: NormalizedPart[] }) {
  useLivePublishes(live)
  return null
}

export interface AgentToolPartProps {
  readonly part: AgentConversationToolPart
}

/**
 * One tool call, where a custom chat places it: the project's view of the tool from `toolViews`,
 * else the framework's own, else a row to inspect its input and output. A project view that throws
 * falls back to the others.
 */
export function AgentToolPart({ part }: AgentToolPartProps) {
  const tool = useMemo(() => normalizedTool(part), [part])
  const view = useAgentToolView(tool.toolName)
  if (!view) return <BuiltInToolRow tool={tool} />

  return <ProjectToolView view={view} tool={tool} fallback={<BuiltInToolRow tool={tool} />} />
}
