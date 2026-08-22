import { AgentChatPage, type AgentChatPageProps } from "@sixb/agent-ui/react-router"
import { createElement } from "react"

export {
  AgentContextProvider,
  AgentPanel,
  type AgentPanelProps,
  useAgentContext,
} from "@sixb/agent-ui"

export { agentContext } from "@sixb/core/agents/context"

export type AgentsPageProps = Omit<AgentChatPageProps, "routeBase">

export default function AgentsPage({ className, ...props }: AgentsPageProps) {
  return createElement(AgentChatPage, {
    ...props,
    routeBase: "/agents",
    className: className
      ? `h-dvh min-h-0 max-h-full overflow-hidden ${className}`
      : "h-dvh min-h-0 max-h-full overflow-hidden",
  })
}
