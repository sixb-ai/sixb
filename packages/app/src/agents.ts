import { AgentChatPage, type AgentChatPageProps } from "@sixb/agent-ui/react-router"
import { createElement } from "react"

export {
  AgentContextProvider,
  AgentPanel,
  type AgentPanelProps,
  AgentSurface,
  type AgentSurfaceMode,
  type AgentSurfaceProps,
  handoffAgentSurfaceThread,
  setAgentSurfaceMode,
  useAgentContext,
} from "@sixb/agent-ui"
export { agentContext } from "@sixb/core/agents/context"
export {
  AppAgentContextProvider,
  type AppAgentContextProviderProps,
} from "./browser-control-react"
export { isAppAgentNavigation } from "./browser-navigation"

export type AgentsPageProps = Omit<AgentChatPageProps, "routeBase">

export default function AgentsPage(props: AgentsPageProps) {
  return createElement(AgentChatPage, {
    ...props,
    routeBase: "/agents",
  })
}
