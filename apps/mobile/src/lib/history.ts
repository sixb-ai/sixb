import { chatTitle } from "./agent/titles"
import type { AgentThreadSummary } from "./agent/types"

const DAY = 24 * 60 * 60 * 1000

export interface HistorySection {
  readonly title: string
  readonly data: readonly AgentThreadSummary[]
}

/** When a chat last moved: its newest message, or its last change for one with none. */
export function lastActivity(thread: AgentThreadSummary): string {
  return thread.lastMessageAt ?? thread.updatedAt
}

/**
 * The history list: the chats whose title contains `search`, grouped by when each last moved.
 * `threads` is newest first, as the API lists them, so each section is a run of neighbors.
 */
export function historySections(
  threads: readonly AgentThreadSummary[],
  search: string,
  now = new Date()
): HistorySection[] {
  const needle = search.trim().toLocaleLowerCase()
  const sections: { title: string; data: AgentThreadSummary[] }[] = []
  for (const thread of threads) {
    if (needle && !chatTitle(thread).toLocaleLowerCase().includes(needle)) continue
    const title = sectionTitle(lastActivity(thread), now)
    const current = sections.at(-1)
    if (current?.title === title) current.data.push(thread)
    else sections.push({ title, data: [thread] })
  }
  return sections
}

/** A chat's time within its history section: "6:14 PM", "Yesterday", "Tuesday", "10/3/26". */
export function historyTime(iso: string, now = new Date()): string {
  const date = new Date(iso)
  const days = daysAgo(iso, now)
  if (days <= 0) return date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })
  if (days === 1) return "Yesterday"
  if (days < 7) return date.toLocaleDateString(undefined, { weekday: "long" })
  return date.toLocaleDateString(undefined, { year: "2-digit", month: "numeric", day: "numeric" })
}

// The section a chat falls under, the way Notes groups notes.
function sectionTitle(iso: string, now: Date): string {
  const days = daysAgo(iso, now)
  if (days <= 0) return "Today"
  if (days === 1) return "Yesterday"
  if (days < 7) return "Previous 7 Days"
  if (days < 30) return "Previous 30 Days"
  const date = new Date(iso)
  return date.getFullYear() === now.getFullYear()
    ? date.toLocaleDateString(undefined, { month: "long" })
    : date.toLocaleDateString(undefined, { month: "long", year: "numeric" })
}

function startOfDay(date: Date): number {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()
}

// Whole calendar days from `iso` to `now`: 0 today, 1 yesterday.
function daysAgo(iso: string, now: Date): number {
  return Math.round((startOfDay(now) - startOfDay(new Date(iso))) / DAY)
}
