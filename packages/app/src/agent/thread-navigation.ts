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
