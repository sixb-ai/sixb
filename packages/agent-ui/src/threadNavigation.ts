import type { AgentThread } from "./types"

export const THREAD_PAGE_SIZE = 50

export function agentThreadTitle(thread: AgentThread | null): string {
  return thread?.title?.trim() || (thread ? "Untitled chat" : "New thread")
}
