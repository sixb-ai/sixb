import { createContext, createElement, type PropsWithChildren, useContext } from "react"
import { AgentChatPage, type AgentChatPageProps } from "./react-router"

type AgentsPageProps = Omit<AgentChatPageProps, "routeBase">

type AgentWorkspaceConfiguration = Pick<AgentsPageProps, "documentPreviewRenderers">

export type AgentWorkspaceProviderProps = PropsWithChildren<AgentWorkspaceConfiguration>

const AgentWorkspaceContext = createContext<AgentWorkspaceConfiguration>({})

/** Configure the framework-owned Agents routes, typically from `app/agents/layout.tsx`. */
export function AgentWorkspaceProvider({
  documentPreviewRenderers,
  children,
}: AgentWorkspaceProviderProps) {
  return createElement(
    AgentWorkspaceContext.Provider,
    { value: { documentPreviewRenderers } },
    children
  )
}

/** The framework's `/agents` routes: the project's conversations, full page. */
export function AgentsPage(props: AgentsPageProps) {
  const workspaceConfiguration = useContext(AgentWorkspaceContext)

  return createElement(AgentChatPage, {
    ...workspaceConfiguration,
    ...props,
    routeBase: "/agents",
  })
}
