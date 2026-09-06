import { AgentChatPage, type AgentChatPageProps } from "@sixb/agent-ui/react-router"
import { createContext, createElement, type PropsWithChildren, useContext } from "react"

export {
  AgentContextProvider,
  type AgentDocumentPreviewRenderer,
  type AgentDocumentPreviewRendererProps,
  type AgentFileRef,
  AgentPanel,
  type AgentPanelProps,
  useAgentContext,
} from "@sixb/agent-ui"

export { agentContext } from "@sixb/core/agents/context"

export type AgentsPageProps = Omit<AgentChatPageProps, "routeBase">

type AgentWorkspaceConfiguration = Pick<
  AgentsPageProps,
  "sidebarHeader" | "sidebarFooter" | "sidebarWidth" | "documentPreviewRenderers"
>

export type AgentWorkspaceProviderProps = PropsWithChildren<AgentWorkspaceConfiguration>

const AgentWorkspaceContext = createContext<AgentWorkspaceConfiguration>({})

/** Configure the framework-owned Agents routes, typically from `app/agents/layout.tsx`. */
export function AgentWorkspaceProvider({
  sidebarHeader,
  sidebarFooter,
  sidebarWidth,
  documentPreviewRenderers,
  children,
}: AgentWorkspaceProviderProps) {
  return createElement(
    AgentWorkspaceContext.Provider,
    { value: { sidebarHeader, sidebarFooter, sidebarWidth, documentPreviewRenderers } },
    children
  )
}

export default function AgentsPage(props: AgentsPageProps) {
  const workspaceConfiguration = useContext(AgentWorkspaceContext)

  return createElement(AgentChatPage, {
    ...workspaceConfiguration,
    ...props,
    routeBase: "/agents",
  })
}
