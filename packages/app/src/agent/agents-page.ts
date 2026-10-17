import { createElement } from "react"
import { AgentChatPage, type AgentChatPageProps } from "./react-router"

/** The framework's `/agents` routes: the project's conversations, full page. */
export function AgentsPage(props: Omit<AgentChatPageProps, "routeBase">) {
  return createElement(AgentChatPage, { ...props, routeBase: "/agents" })
}
