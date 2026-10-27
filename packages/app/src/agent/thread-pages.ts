import { createElement } from "react"
import { Navigate, useParams } from "react-router-dom"
import { AgentChatPage, type AgentChatPageProps, AgentThreadsPage } from "./react-router"
import { THREADS_PATH, threadPath } from "./thread-navigation"

/** The framework's `/threads/:threadId` route: one thread, full page. */
export function ThreadPage(props: Omit<AgentChatPageProps, "routeBase">) {
  return createElement(AgentChatPage, props)
}

/** The framework's `/threads` route: every thread, to search and open. */
export const ThreadsPage = AgentThreadsPage

/**
 * Threads used to open at `/agents/:threadId`, and memory saves still name their thread that way:
 * those links open the thread at its page.
 */
export function AgentThreadRedirect() {
  const { threadId } = useParams()
  return createElement(Navigate, {
    to: threadId ? threadPath(threadId) : THREADS_PATH,
    replace: true,
  })
}
