import { type AgentMessages, en } from "./i18n/en"
import type { AgentThread } from "./types"

export const THREAD_PAGE_SIZE = 50

export function agentThreadTitle(
  thread: AgentThread | null,
  messages: AgentMessages["threads"] = en.threads
): string {
  return thread?.title?.trim() || (thread ? messages.untitled : messages.new)
}
