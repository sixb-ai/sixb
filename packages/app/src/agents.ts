import { AgentChatPage, type AgentChatPageProps } from "@sixb/agent-ui/react-router"
import { createContext, createElement, type PropsWithChildren, useContext } from "react"

export {
  AgentContextProvider,
  AgentPanel,
  type AgentPanelProps,
  useAgentContext,
} from "@sixb/agent-ui"

export { agentContext } from "@sixb/core/agents/context"

export type AgentsPageProps = Omit<AgentChatPageProps, "routeBase">

type AgentWorkspaceChrome = Pick<
  AgentsPageProps,
  "sidebarHeader" | "sidebarFooter" | "sidebarWidth"
>

export type AgentWorkspaceProviderProps = PropsWithChildren<AgentWorkspaceChrome>

const AgentWorkspaceContext = createContext<AgentWorkspaceChrome>({})

/** Configure the framework-owned Agents routes from a custom app's root layout. */
export function AgentWorkspaceProvider({
  sidebarHeader,
  sidebarFooter,
  sidebarWidth,
  children,
}: AgentWorkspaceProviderProps) {
  return createElement(
    AgentWorkspaceContext.Provider,
    { value: { sidebarHeader, sidebarFooter, sidebarWidth } },
    children
  )
}

export default function AgentsPage(props: AgentsPageProps) {
  const workspaceChrome = useContext(AgentWorkspaceContext)

  return createElement(AgentChatPage, {
    ...workspaceChrome,
    ...props,
    routeBase: "/agents",
  })
}
