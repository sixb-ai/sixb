import { AgentChatPage, type AgentChatPageProps } from "@sixb/agent-ui/react-router"
import { createElement } from "react"

export type AgentsPageProps = Omit<AgentChatPageProps, "routeBase">

export default function AgentsPage({ className, ...props }: AgentsPageProps) {
  return createElement(AgentChatPage, {
    ...props,
    routeBase: "/agents",
    className: className
      ? `h-dvh min-h-dvh max-h-dvh overflow-hidden ${className}`
      : "h-dvh min-h-dvh max-h-dvh overflow-hidden",
  })
}
