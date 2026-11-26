import { createContext, useContext } from "react"
import { type AgentMessages, en } from "./i18n/en"
import type { AgentThread } from "./types"

export const THREAD_PAGE_SIZE = 50

export function agentThreadTitle(
  thread: AgentThread | null,
  messages: AgentMessages["threads"] = en.threads
): string {
  return thread?.title?.trim() || (thread ? messages.untitled : messages.new)
}

/** The app's page of every thread; each thread opens beneath it. */
export const THREADS_PATH = "/threads"

export function threadPath(threadId: string): string {
  return `${THREADS_PATH}/${encodeURIComponent(threadId)}`
}

/**
 * The page a stored thread link opens. Memory saves name the thread they came from as
 * `/agents/<threadId>`, the form core checks them against; this links straight to its page.
 */
export function threadPathFromLink(link: string): string {
  const legacy = /^\/agents\/([^/?#]+)$/.exec(link)
  return legacy?.[1] ? threadPath(decodeURIComponent(legacy[1])) : link
}

/**
 * Opens another conversation the way the chat around it navigates: a page of its own under the
 * host's routes, or the thread an embedded panel shows. Null outside a chat, such as a
 * conversation read in Settings, where nothing opens another one.
 */
export const ThreadNavigationContext = createContext<((threadId: string) => void) | null>(null)

export function useThreadNavigation(): ((threadId: string) => void) | null {
  return useContext(ThreadNavigationContext)
}
